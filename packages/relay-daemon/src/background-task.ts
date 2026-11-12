/** A critical loop must not silently disappear while the daemon admits work. */
export async function superviseBackgroundTask(
  name: string,
  signal: AbortSignal,
  work: () => Promise<void>,
  onFailure: (error: unknown) => void,
): Promise<void> {
  let failure: unknown = new Error(`${name} stopped unexpectedly.`);
  try { await work(); }
  catch (error) { failure = error; }
  if (!signal.aborted) onFailure(failure);
}
