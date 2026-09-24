/**
 * A day key ("2026-07-19") as the local calendar day it names. `new Date(key)`
 * would parse it as UTC midnight and shift the day for anyone west of UTC.
 * The inverse is `isoToday(date)` in routine.ts. Returns undefined for an
 * empty key and for one that names no real day ("2026-02-31").
 */
export function dateFromKey(key: string): Date | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!match) return undefined;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(year, month - 1, day);
  const real = date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
  return real ? date : undefined;
}
