import { spawn, spawnSync } from "node:child_process";
import type { StreamExecResult } from "relay-core";
import { BoundedTextCapture } from "./bounded-text.js";
import { RELEASED_EXIT_MESSAGE, exitHooksFor } from "./execution-capture.js";
import { listWindowsProcesses, taskkillArguments, windowsProcessTree } from "./windows-process-tree.js";

const SIGKILL_DELAY_MS = 5_000;
/** Between Windows tree sweeps while descendants remain. */
const WINDOWS_SWEEP_MS = 1_000;
/** How long verified-empty Windows trees may keep their pipes open. */
const WINDOWS_PIPE_DRAIN_MS = 2_000;

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
    const windows = process.platform === "win32";
    const detached = !windows;
    const child = spawn(cmd, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached,
      windowsHide: true,
    });
    const spawnedAt = Date.now();
    // POSIX records the process group; Windows the tree's root pid, which its
    // descendants keep naming as parent even after it exits.
    if (child.pid) hooks?.onSpawn?.(child.pid, spawnedAt);
    const stdoutCapture = new BoundedTextCapture();
    const stderrCapture = new BoundedTextCapture();
    let finished = false;
    let killTimer: NodeJS.Timeout | undefined;
    let reportTimer: NodeJS.Timeout | undefined;
    let cleanupTimer: NodeJS.Timeout | undefined;
    let reported = false;
    let exitCode: number | null | undefined;
    let closed = false;
    let windowsCleanup: Promise<void> | undefined;
    let windowsTreeCleared = false;
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
      if (windows) {
        void killWindowsTree();
        return;
      }
      child.kill(signal);
    };
    /**
     * Windows has no process groups and no signals. Ends every live member of
     * the run's tree, orphans included; true once none remain, undefined when
     * Windows could not list its processes.
     */
    const killWindowsTree = async (): Promise<boolean | undefined> => {
      const processes = child.pid ? await listWindowsProcesses() : undefined;
      if (!processes || !child.pid) {
        // Best effort: taskkill /T still reaches descendants whose parents live.
        if (child.pid && child.exitCode === null) {
          spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
        }
        return undefined;
      }
      const members = windowsProcessTree(processes, child.pid, spawnedAt);
      if (members.length === 0) return true;
      spawnSync("taskkill", taskkillArguments(members), { stdio: "ignore", windowsHide: true });
      return false;
    };
    /**
     * Once bash exits on Windows, clear what it left running before reporting
     * the run finished, as the POSIX path does for its process group. A
     * descendant holding the inherited pipes would otherwise keep `close`
     * from ever firing.
     */
    const finishWindowsRun = (): void => {
      windowsCleanup ??= (async () => {
        let warned = false;
        for (;;) {
          if (finished) return;
          const cleared = await killWindowsTree();
          if (finished) return;
          if (cleared === true) { windowsTreeCleared = true; break; }
          // Without a process list this is the old behaviour: report on close.
          if (cleared === undefined && closed) { settle(exitCode ?? -1); return; }
          if (cleared === false) {
            scheduleExitReport();
            if (!warned) { process.stderr.write("[relay] Run's descendants are still running; ending them before reporting exit.\n"); warned = true; }
          }
          await new Promise((resolve) => { cleanupTimer = setTimeout(resolve, WINDOWS_SWEEP_MS); });
        }
        if (closed) { settle(exitCode ?? -1); return; }
        // Every process of the tree is gone, so whatever still holds the pipes
        // is not part of this run. Stop waiting for them.
        cleanupTimer = setTimeout(() => {
          if (finished) return;
          child.stdout.destroy();
          child.stderr.destroy();
          settle(exitCode ?? -1);
        }, WINDOWS_PIPE_DRAIN_MS);
      })();
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
    child.on("exit", (code) => {
      exitCode = code;
      if (finished) return;
      if (windows) finishWindowsRun();
      else if (child.pid) terminate("SIGKILL");
    });
    child.on("close", (code) => {
      closed = true;
      exitCode ??= code;
      if (finished) return;
      if (windows && child.pid) {
        if (killTimer) clearTimeout(killTimer);
        options.signal?.removeEventListener("abort", abort);
        if (windowsTreeCleared) settle(exitCode ?? -1);
        else finishWindowsRun();
        return;
      }
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
