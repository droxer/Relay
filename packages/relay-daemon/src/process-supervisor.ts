import { spawn } from "node:child_process";
import type { StreamExecResult } from "relay-core";
import { BoundedTextCapture } from "./bounded-text.js";
import { RELEASED_EXIT_MESSAGE, exitHooksFor } from "./execution-capture.js";

const SIGKILL_DELAY_MS = 5_000;

export async function superviseLocalProcess(
  cmd: string,
  args: string[] = [],
  options: {
    cwd?: string;
    stdoutRenderer?: (chunk: string) => string;
    stderrRenderer?: (chunk: string) => string;
    sink?: (text: string) => void;
    signal?: AbortSignal;
    env?: Record<string, string>;
    cleanupTimeoutMs?: number;
    /** How long group cleanup may stay unverified before the daemon says so. */
    exitUnconfirmedAfterMs?: number;
  } = {},
): Promise<StreamExecResult> {
  if (options.signal?.aborted) {
    return {
      exit_code: -1,
      stdout: "",
      stderr: "",
      error_message: "Execution cancelled before start.",
    };
  }
  const hooks = exitHooksFor(options.signal);
  return new Promise((resolve) => {
    const detached = process.platform !== "win32";
    const child = spawn(cmd, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached,
    });
    if (detached && child.pid) hooks?.onSpawn?.(child.pid);
    const stdoutCapture = new BoundedTextCapture();
    const stderrCapture = new BoundedTextCapture();
    let released = false;
    let killTimer: NodeJS.Timeout | undefined;
    const terminate = (signal: NodeJS.Signals): void => {
      if (detached && child.pid) {
        try {
          process.kill(-child.pid, signal);
          return;
        } catch {
          // Fall back to the direct child below if the process group is gone.
        }
      }
      child.kill(signal);
    };
    const abort = (): void => {
      terminate("SIGTERM");
      // Escalate in case the agent ignores SIGTERM.
      killTimer = setTimeout(() => terminate("SIGKILL"), SIGKILL_DELAY_MS);
      killTimer.unref?.();
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (text: string) => {
      stdoutCapture.append(text);
      const rendered = options.stdoutRenderer ? options.stdoutRenderer(text) : text;
      if (rendered) options.sink?.(rendered);
    });
    child.stderr.on("data", (text: string) => {
      stderrCapture.append(text);
      const rendered = options.stderrRenderer ? options.stderrRenderer(text) : text;
      if (rendered) options.sink?.(rendered);
    });
    // Parent exit precedes pipe EOF when a descendant inherited stdout/stderr.
    // Clean the process group immediately so those pipes cannot strand exit.
    child.on("exit", () => { if (detached && child.pid) terminate("SIGKILL"); });
    child.on("close", async (code) => {
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", abort);
      if (detached && child.pid) {
        // The parent can exit before a child that closed its inherited pipes.
        // Finish the process group before reporting a terminal execution; do
        // not cancel escalation just because the parent emitted close.
        terminate("SIGKILL");
        const groupId = child.pid;
        const cleanupStartedAt = Date.now();
        const cleanupDeadline = cleanupStartedAt + (options.cleanupTimeoutMs ?? 5_000);
        const unconfirmedAfterMs = options.exitUnconfirmedAfterMs ?? 60_000;
        let reported = false;
        await new Promise<void>((finished) => {
          let warned = false;
          const check = (): void => {
            // Only a person reporting the run gone may end an unverified wait.
            if (hooks?.release?.aborted) {
              released = true;
              finished();
              return;
            }
            if (!reported && Date.now() - cleanupStartedAt >= unconfirmedAfterMs) {
              reported = true;
              hooks?.onExitUnconfirmed?.();
            }
            try { process.kill(-groupId, 0); } catch (error) {
              if ((error as NodeJS.ErrnoException).code === "ESRCH") {
                finished();
              } else {
                if (!warned) { process.stderr.write("[relay] Cannot verify process-group termination; retaining execution.\n"); warned = true; }
                setTimeout(check, 100);
              }
              return;
            }
            if (!warned && Date.now() >= cleanupDeadline) {
              process.stderr.write("[relay] Process cleanup overdue; descendants may still be running. Retaining execution.\n");
              warned = true;
            }
            terminate("SIGKILL");
            setTimeout(check, 100);
          };
          check();
        });
      }
      resolve({
        exit_code: released ? -1 : code ?? -1,
        stdout: stdoutCapture.toString(),
        stderr: stderrCapture.toString(),
        ...(released ? { error_message: RELEASED_EXIT_MESSAGE } : {}),
      });
    });
    child.on("error", (error) => {
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", abort);
      resolve({
        exit_code: -1,
        stdout: stdoutCapture.toString(),
        stderr: stderrCapture.toString(),
        error_message: error.message,
      });
    });
  });
}
