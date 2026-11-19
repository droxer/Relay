import { spawn, spawnSync } from "node:child_process";
import type { StreamExecResult } from "relay-core";
import { BoundedTextCapture } from "./bounded-text.js";
import { RELEASED_EXIT_MESSAGE, exitHooksFor } from "./execution-capture.js";
import { listWindowsProcesses, taskkillArguments, windowsProcessTree } from "./windows-process-tree.js";
import { processGroupAlive } from "./process-group.js";
import { cleanupLinuxRunCgroup, createLinuxRunCgroup, linuxRunInvocation } from "./linux-run-cgroup.js";

const SIGKILL_DELAY_MS = 5_000;
/** Between Windows tree sweeps while descendants remain. */
const WINDOWS_SWEEP_MS = 1_000;
/** How long output may drain after all designated processes have exited. */
const VERIFIED_PIPE_DRAIN_MS = 2_000;

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
  const hooks = exitHooksFor(options.signal);
  if (options.signal?.aborted || hooks?.forceStop?.aborted) {
    return {
      exit_code: -1,
      stdout: "",
      stderr: "",
      error_message: "Execution cancelled before start.",
    };
  }
  const recordGroup = hooks?.onCgroup;
  const group = recordGroup && createLinuxRunCgroup();
  if (group && recordGroup) {
    try { recordGroup(group); }
    catch (error) {
      cleanupLinuxRunCgroup(group, false);
      throw error;
    }
  }
  const invocation = group ? linuxRunInvocation(group, cmd, args) : { command: cmd, args };
  return new Promise((resolve) => {
    const windows = process.platform === "win32";
    const detached = !windows;
    let child;
    try {
      child = spawn(invocation.command, invocation.args, {
        cwd: options.cwd,
        env: options.env,
        stdio: ["ignore", "pipe", "pipe"],
        detached,
        windowsHide: true,
      });
    } catch (error) {
      if (group) cleanupLinuxRunCgroup(group, false);
      throw error;
    }
    const spawnedAt = Date.now();
    // POSIX records the process group; Windows the tree's root pid, which its
    // descendants keep naming as parent even after it exits.
    if (!group && child.pid) hooks?.onSpawn?.(child.pid, spawnedAt);
    const stdoutCapture = new BoundedTextCapture();
    const stderrCapture = new BoundedTextCapture();
    let finished = false;
    let killTimer: NodeJS.Timeout | undefined;
    let reportTimer: NodeJS.Timeout | undefined;
    let cleanupTimer: NodeJS.Timeout | undefined;
    let terminationRetryTimer: NodeJS.Timeout | undefined;
    let processErrorReported = false;
    let reported = false;
    let exitCode: number | null | undefined;
    let closed = false;
    let windowsCleanup: Promise<void> | undefined;
    let windowsTermination: Promise<boolean | undefined> | undefined;
    let descendantsCleared = false;
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
      if (terminationRetryTimer) clearInterval(terminationRetryTimer);
      options.signal?.removeEventListener("abort", abort);
      hooks?.forceStop?.removeEventListener("abort", forceStop);
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
      if (group) {
        if (signal === "SIGKILL") cleanupLinuxRunCgroup(group, true);
        else if (exitCode === undefined) child.kill(signal);
        return;
      }
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
    const sweepWindowsTree = async (): Promise<boolean | undefined> => {
      const processes = child.pid ? await listWindowsProcesses() : undefined;
      if (!processes || !child.pid) {
        // The ChildProcess handle identifies the original root even if its
        // PID is later reused. Without enumeration, descendant exit is unknown.
        if (child.exitCode === null) child.kill("SIGKILL");
        return undefined;
      }
      const members = windowsProcessTree(processes, child.pid, spawnedAt);
      if (members.length === 0) return true;
      spawnSync("taskkill", taskkillArguments(members), { stdio: "ignore", windowsHide: true });
      return false;
    };
    const killWindowsTree = (): Promise<boolean | undefined> => {
      // Shutdown escalation and exit cleanup can overlap on the same tree.
      return windowsTermination ??= sweepWindowsTree().finally(() => { windowsTermination = undefined; });
    };
    const finishVerifiedRun = (): void => {
      descendantsCleared = true;
      if (closed) { settle(exitCode ?? -1); return; }
      // Verified exit means any remaining pipe holders cannot hold the run.
      cleanupTimer = setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        settle(exitCode ?? -1);
      }, VERIFIED_PIPE_DRAIN_MS);
    };
    const finishContainedRun = (): void => {
      if (!group || finished || descendantsCleared) return;
      if (cleanupLinuxRunCgroup(group, true)) { finishVerifiedRun(); return; }
      scheduleExitReport();
      cleanupTimer = setTimeout(finishContainedRun, 100);
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
          if (cleared === true) break;
          scheduleExitReport();
          if (!warned) {
            process.stderr.write(cleared === undefined
              ? "[relay] Cannot enumerate the run's descendants; retaining execution until cleanup can be verified.\n"
              : "[relay] Run's descendants are still running; ending them before reporting exit.\n");
            warned = true;
          }
          await new Promise((resolve) => { cleanupTimer = setTimeout(resolve, WINDOWS_SWEEP_MS); });
        }
        finishVerifiedRun();
      })();
    };
    const forceStop = (): void => {
      if (finished) return;
      if (killTimer) clearTimeout(killTimer);
      scheduleExitReport();
      terminate("SIGKILL");
      if (group && !terminationRetryTimer) {
        terminationRetryTimer = setInterval(() => terminate("SIGKILL"), 1_000);
        terminationRetryTimer.unref();
      }
    };
    const abort = (): void => {
      scheduleExitReport();
      terminate("SIGTERM");
      // Escalate in case the agent ignores SIGTERM.
      killTimer = setTimeout(forceStop, hooks?.stopGraceMs ?? SIGKILL_DELAY_MS);
      killTimer.unref?.();
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    hooks?.forceStop?.addEventListener("abort", forceStop, { once: true });
    hooks?.release?.addEventListener("abort", release, { once: true });
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
      if (group) finishContainedRun();
      else if (windows) finishWindowsRun();
      else if (child.pid) terminate("SIGKILL");
    });
    child.on("close", (code) => {
      closed = true;
      exitCode ??= code;
      if (finished) return;
      if (group) {
        if (descendantsCleared) settle(exitCode ?? -1);
        return;
      }
      if (windows && child.pid) {
        if (killTimer) clearTimeout(killTimer);
        options.signal?.removeEventListener("abort", abort);
        if (descendantsCleared) settle(exitCode ?? -1);
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
          let alive: boolean;
          try { alive = processGroupAlive(groupId); } catch {
            if (!warned) { process.stderr.write("[relay] Cannot verify process-group termination; retaining execution.\n"); warned = true; }
            cleanupTimer = setTimeout(check, 100);
            return;
          }
          // Only zombies left (or nothing): no member can execute any more.
          if (!alive) {
            settle(code ?? -1);
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
      // Spawn failure means there was no execution. A later error (including
      // EPERM from kill) says nothing about whether the process is still alive.
      if (!child.pid) {
        if (group) cleanupLinuxRunCgroup(group, false);
        settle(-1, error.message);
        return;
      }
      if (finished) return;
      scheduleExitReport();
      if (!processErrorReported) {
        processErrorReported = true;
        process.stderr.write(`[relay] Process operation failed; retaining execution: ${error.message}\n`);
      }
      if (windows) finishWindowsRun();
      else if (!terminationRetryTimer) {
        terminationRetryTimer = setInterval(() => terminate("SIGKILL"), 1000);
        terminationRetryTimer.unref();
      }
    });
    // Register error/exit handlers before an already-aborted signal can try
    // to kill a process and synchronously emit a ChildProcess error.
    if (options.signal?.aborted) abort();
    if (hooks?.forceStop?.aborted) forceStop();
    if (hooks?.release?.aborted) release();
  });
}
