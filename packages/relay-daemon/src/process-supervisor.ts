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
    let finished = false;
    let killTimer: NodeJS.Timeout | undefined;
    let reportTimer: NodeJS.Timeout | undefined;
    let cleanupTimer: NodeJS.Timeout | undefined;
    let reported = false;
    const scheduleExitReport = (): void => {
      if (reportTimer || reported || finished) return;
      reportTimer = setTimeout(() => {
        reportTimer = undefined;
        if (finished) return;
        reported = true;
        hooks?.onExitUnconfirmed?.();
      }, options.exitUnconfirmedAfterMs ?? 60_000);
      reportTimer.unref?.();
    };
    const settle = (code: number, errorMessage?: string, released = false): void => {
      if (finished) return;
      finished = true;
      if (killTimer) clearTimeout(killTimer);
      if (reportTimer) clearTimeout(reportTimer);
      if (cleanupTimer) clearTimeout(cleanupTimer);
      options.signal?.removeEventListener("abort", abort);
      hooks?.release?.removeEventListener("abort", release);
      if (released) {
        // An operator assertion frees the slot even when the child or its
        // inherited pipes never close. Stop capturing and retaining handles.
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
      }
      resolve({
        exit_code: code,
        stdout: stdoutCapture.toString(),
        stderr: stderrCapture.toString(),
        ...(errorMessage ? { error_message: errorMessage } : {}),
      });
    };
    const release = (): void => settle(-1, RELEASED_EXIT_MESSAGE, true);
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
      scheduleExitReport();
      terminate("SIGTERM");
      // Escalate in case the agent ignores SIGTERM.
      killTimer = setTimeout(() => terminate("SIGKILL"), SIGKILL_DELAY_MS);
      killTimer.unref?.();
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    hooks?.release?.addEventListener("abort", release, { once: true });
    if (options.signal?.aborted) abort();
    if (hooks?.release?.aborted) release();
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (text: string) => {
      if (finished) return;
      stdoutCapture.append(text);
      const rendered = options.stdoutRenderer ? options.stdoutRenderer(text) : text;
      if (rendered) options.sink?.(rendered);
    });
    child.stderr.on("data", (text: string) => {
      if (finished) return;
      stderrCapture.append(text);
      const rendered = options.stderrRenderer ? options.stderrRenderer(text) : text;
      if (rendered) options.sink?.(rendered);
    });
    // Parent exit precedes pipe EOF when a descendant inherited stdout/stderr.
    // Clean the process group immediately so those pipes cannot strand exit.
    child.on("exit", () => { if (!finished && detached && child.pid) terminate("SIGKILL"); });
    child.on("close", (code) => {
      if (finished) return;
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", abort);
      if (detached && child.pid) {
        // The parent can exit before a child that closed its inherited pipes.
        // Finish the process group before reporting a terminal execution; do
        // not cancel escalation just because the parent emitted close.
        terminate("SIGKILL");
        const groupId = child.pid;
        const cleanupDeadline = Date.now() + (options.cleanupTimeoutMs ?? 5_000);
        scheduleExitReport();
        let warned = false;
        const check = (): void => {
          if (finished) return;
          try { process.kill(-groupId, 0); } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ESRCH") {
              settle(code ?? -1);
            } else {
              if (!warned) { process.stderr.write("[relay] Cannot verify process-group termination; retaining execution.\n"); warned = true; }
              cleanupTimer = setTimeout(check, 100);
            }
            return;
          }
          if (!warned && Date.now() >= cleanupDeadline) {
            process.stderr.write("[relay] Process cleanup overdue; descendants may still be running. Retaining execution.\n");
            warned = true;
          }
          terminate("SIGKILL");
          cleanupTimer = setTimeout(check, 100);
        };
        check();
        return;
      }
      settle(code ?? -1);
    });
    child.on("error", (error) => {
      settle(-1, error.message);
    });
  });
}
