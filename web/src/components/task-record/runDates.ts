/** A run's day, with the year only when it is not this year — a ledger that
 *  crosses New Year must not show two "Jan 3"s a year apart. */
export function runDate(value: string | null | undefined, locale: string): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const year = date.getFullYear() === new Date().getFullYear() ? undefined : "numeric";
  return new Intl.DateTimeFormat(locale || undefined, { month: "short", day: "numeric", year }).format(date);
}

/** A run's clock time; empty when it has none worth showing. */
export function runTime(value: string | null | undefined, locale: string): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(locale || undefined, { hour: "2-digit", minute: "2-digit" }).format(date);
}
