import { spawn } from "node:child_process";
import type { StreamExecResult } from "relay-core";
import { BoundedTextCapture } from "./bounded-text.js";

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
  return new Promise((resolve) => {
    const detached = process.platform !== "win32";
    const child = spawn(cmd, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached,
    });
    const stdoutCapture = new BoundedTextCapture();
    const stderrCapture = new BoundedTextCapture();
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
    child.on("close", async (code) => {
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", abort);
      if (detached && child.pid) {
        // The parent can exit before a child that closed its inherited pipes.
        // Finish the process group before reporting a terminal execution; do
        // not cancel escalation just because the parent emitted close.
        terminate("SIGKILL");
        const groupId = child.pid;
        const cleanupDeadline = Date.now() + (options.cleanupTimeoutMs ?? 5_000);
        const cleanupError = await new Promise<string | undefined>((finished) => {
          const check = (): void => {
            try { process.kill(-groupId, 0); } catch (error) {
              if ((error as NodeJS.ErrnoException).code === "ESRCH") {
                finished(undefined);
              } else {
                finished("Process cleanup could not verify termination.");
              }
              return;
            }
            if (Date.now() >= cleanupDeadline) {
              finished("Process cleanup timed out; descendants may still be running.");
              return;
            }
            setTimeout(check, Math.min(100, Math.max(1, cleanupDeadline - Date.now())));
          };
          check();
        });
        if (cleanupError) {
          resolve({ exit_code: -1, stdout: stdoutCapture.toString(), stderr: stderrCapture.toString(), error_message: cleanupError });
          return;
        }
      }
      resolve({
        exit_code: code ?? -1,
        stdout: stdoutCapture.toString(),
        stderr: stderrCapture.toString(),
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
