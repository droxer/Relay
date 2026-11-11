/** A deadline bounds waiting, never asserts that the underlying execution stopped. */
export class ExecutionDeadlineError extends Error {}
export class ExecutionCleanupError extends Error {}

export async function withExecutionDeadline<T>(work: Promise<T>, milliseconds: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new ExecutionDeadlineError(`${label} timed out after ${milliseconds} ms; exit is unconfirmed.`)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}
