import type { AgentOutputSink, StreamExecResult } from "relay-core";
import { BoundedTextCapture } from "./bounded-text.js";
type StreamRenderer = (chunk: string) => string;

export interface ExecutionRecoveryOptions {
  retryMs?: number;
  graceMs?: number;
  /** Bound draining only when the adapter also verifies descendant cleanup. */
  streamDrainMs?: number;
  terminate?: (force: boolean) => Promise<void>;
  warn?: (message: string) => void;
}

export async function collectExecution(
  execution: any,
  echo = false,
  stdoutRenderer?: StreamRenderer,
  stderrRenderer?: StreamRenderer,
  sink?: AgentOutputSink,
  signal?: AbortSignal,
  recovery: ExecutionRecoveryOptions = {},
): Promise<StreamExecResult> {
  const stdoutCapture = new BoundedTextCapture();
  const stderrCapture = new BoundedTextCapture();
  const retryMs = recovery.retryMs ?? 1000;
  const graceMs = recovery.graceMs ?? 5000;
  const warn = recovery.warn ?? ((message: string) => { process.stderr.write(`[relay] ${message}\n`); });
  let cancelled = false;
  let finished = false;
  let exited = false;
  let stoppingAt: number | undefined;
  let stopTimer: NodeJS.Timeout | undefined;
  let overdue = false;
  let terminating = false;
  const terminate = async (): Promise<void> => {
    if (exited || terminating) return;
    terminating = true;
    const force = Date.now() - stoppingAt! >= graceMs;
    let timeout: NodeJS.Timeout | undefined;
    try {
      const action = recovery.terminate ? recovery.terminate(force)
        : !force && execution.signal ? execution.signal(15) : execution.kill?.();
      await Promise.race([action, new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("Termination request timed out.")), retryMs);
      })]);
    } catch (error) {
      warn(`Execution termination failed; retaining the run: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      if (timeout) clearTimeout(timeout);
      terminating = false;
    }
    if (!exited && !overdue && Date.now() - stoppingAt! >= graceMs + retryMs) {
      overdue = true;
      warn("Cancellation overdue: waiting for verified process exit; the execution remains reserved.");
    }
  };
  const requestStop = (): void => {
    if (stoppingAt !== undefined || exited) return;
    stoppingAt = Date.now();
    void terminate();
    stopTimer = setInterval(() => { void terminate(); }, retryMs);
  };
  const abortExecution = (): void => { cancelled = true; requestStop(); };
  if (signal?.aborted) abortExecution();
  signal?.addEventListener("abort", abortExecution, { once: true });

  async function waitForConfirmedExit(): Promise<any> {
    let warned = false;
    for (;;) {
      try { return await execution.wait(); } catch {
        if (!warned) {
          warn("Cannot confirm sandbox execution exit; retaining the run.");
          warned = true;
        }
        requestStop();
        await new Promise(resolve => setTimeout(resolve, retryMs));
      }
    }
  }
  async function readStream(name: "stdout" | "stderr", capture: BoundedTextCapture): Promise<void> {
    const reader = await execution[name]();
    const decoder = new TextDecoder("utf-8");
    const renderer = name === "stderr" ? stderrRenderer : stdoutRenderer;
    const pushText = (text: string): void => {
      if (!text || finished) return;
      capture.append(text);
      // Renderers carry the live event feed, so they see every chunk; `echo`
      // only decides whether output without a sink reaches this terminal.
      const rendered = renderer ? renderer(text) : text;
      if (sink) {
        if (rendered) sink(rendered);
        return;
      }
      if (!echo || !rendered) return;
      if (name === "stderr") {
        process.stderr.write(rendered);
      } else {
        process.stdout.write(rendered);
      }
    };
    while (true) {
      const chunk = await reader.next();
      if (chunk === null) break;
      const text = typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
      pushText(text);
    }
    pushText(decoder.decode());
  }

  // Observe exit immediately, even if stdin closing or inherited pipes stall.
  const exit = waitForConfirmedExit().then(result => {
    exited = true;
    if (stopTimer) clearInterval(stopTimer);
    return result;
  });
  let streamError: unknown;
  const streams = Promise.all([
    closeExecutionStdin(execution),
    readStream("stdout", stdoutCapture), readStream("stderr", stderrCapture),
  ]).catch(error => { streamError = error; requestStop(); });
  let drainTimer: NodeJS.Timeout | undefined;
  try {
    const result = await exit;
    if (recovery.streamDrainMs === undefined) await streams;
    else await Promise.race([streams, new Promise<void>(resolve => {
      drainTimer = setTimeout(() => {
        warn("Process exit confirmed; output drain timed out. Saving the captured transcript.");
        resolve();
      }, recovery.streamDrainMs);
    })]);
    if (streamError) throw streamError;
    return {
      exit_code: result.exitCode ?? -1,
      stdout: stdoutCapture.toString(), stderr: stderrCapture.toString(),
      error_message: cancelled ? "Execution cancelled." : result.errorMessage,
    };
  } finally {
    finished = true;
    if (stopTimer) clearInterval(stopTimer);
    if (drainTimer) clearTimeout(drainTimer);
    signal?.removeEventListener("abort", abortExecution);
  }
}

async function closeExecutionStdin(execution: any): Promise<void> {
  if (typeof execution.stdin !== "function") return;
  try {
    const stdin = await execution.stdin();
    await stdin?.close?.();
  } catch {
    // Some BoxLite runtimes may not expose stdin for every execution.
  }
}
