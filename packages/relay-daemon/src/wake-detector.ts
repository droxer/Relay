/**
 * Notices that this process stopped running for a while: the computer slept,
 * or the process was suspended. Timers do not fire during the pause, so a
 * tick that arrives far later than scheduled is the evidence.
 *
 * Every connection open before the pause is suspect afterwards (the peer has
 * usually dropped it without this side hearing), so the caller reconnects at
 * once instead of waiting out each request's deadline.
 */
export const WAKE_CHECK_INTERVAL_MS = 5_000;
export const WAKE_GAP_THRESHOLD_MS = 20_000;

export function watchForWake(
  onWake: (pausedMs: number) => void,
  options: { intervalMs?: number; thresholdMs?: number; now?: () => number } = {},
): () => void {
  const intervalMs = options.intervalMs ?? WAKE_CHECK_INTERVAL_MS;
  const thresholdMs = options.thresholdMs ?? WAKE_GAP_THRESHOLD_MS;
  // Wall-clock on purpose: a monotonic clock may not advance while suspended.
  const now = options.now ?? Date.now;
  let last = now();
  const timer = setInterval(() => {
    const current = now();
    const pausedMs = current - last - intervalMs;
    last = current;
    if (pausedMs >= thresholdMs) onWake(pausedMs);
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
