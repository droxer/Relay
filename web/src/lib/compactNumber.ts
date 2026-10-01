// Compact notation earns its keep on token counts (2.7M) but throws away
// precision on the numbers an operator actually reads back — 1,041 threads
// became "1K". Group below 100k, compact above.
export const COMPACT_THRESHOLD = 100_000;

/** The dashboard's one number voice: grouped below 100k, compact above. */
export function formatCompact(value: number, locale: string): string {
  return value < COMPACT_THRESHOLD
    ? new Intl.NumberFormat(locale).format(value)
    : new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 1 }).format(value);
}
