/** A deadline bounds waiting, never asserts that the underlying execution stopped. */
export class ExecutionDeadlineError extends Error {}
export class ExecutionCleanupError extends Error {}

export async function withExecutionDeadline<T>(work: Promise<T>, milliseconds: number, label: string, signal?: AbortSignal): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new ExecutionDeadlineError(`${label} timed out after ${milliseconds} ms; exit is unconfirmed.`)), milliseconds);
      onAbort = () => reject(signal?.reason);
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
    })]);
  } finally {
    clearTimeout(timer);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
  }
}
