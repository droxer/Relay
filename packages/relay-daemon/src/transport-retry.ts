/** HTTP Retry-After is a minimum delay, independent of our jittered backoff. */
export function retryAfterMs(value: string | null, now = Date.now()): number {
  const text = value?.trim();
  if (!text || /^[+-]/.test(text)) return 0;
  const milliseconds = /^\d+(?:\.\d+)?$/.test(text) ? Number(text) * 1000 : Date.parse(text) - now;
  return Number.isFinite(milliseconds) ? Math.max(0, milliseconds) : 0;
}
