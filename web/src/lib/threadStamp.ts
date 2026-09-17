/* The rail's "3d ago" stamp.

   A formatter per locale, built once. The row used to construct an
   Intl.RelativeTimeFormat on every render, and with every row re-rendering on
   every poll that constructor was the hottest function on an idle page. The
   clock is a parameter rather than Date.now() so a memoized row re-renders
   when the rail's minute clock ticks, and not otherwise. */

const formatters = new Map<string, Intl.RelativeTimeFormat>();

export function threadStampFormatter(locale: string): Intl.RelativeTimeFormat {
  let formatter = formatters.get(locale);
  if (!formatter) {
    formatter = new Intl.RelativeTimeFormat(locale, { numeric: "auto", style: "narrow" });
    formatters.set(locale, formatter);
  }
  return formatter;
}

export function formatThreadStamp(iso: string | undefined, locale: string, now: number): string {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "";
  const formatter = threadStampFormatter(locale);
  const sec = Math.round(Math.max(0, now - then) / 1000);
  if (sec < 60) return formatter.format(-sec, "second");
  const min = Math.round(sec / 60);
  if (min < 60) return formatter.format(-min, "minute");
  const hr = Math.round(min / 60);
  if (hr < 24) return formatter.format(-hr, "hour");
  const day = Math.round(hr / 24);
  if (day < 7) return formatter.format(-day, "day");
  const wk = Math.round(day / 7);
  if (wk < 5) return formatter.format(-wk, "week");
  const mo = Math.round(day / 30);
  if (mo < 12) return formatter.format(-mo, "month");
  return formatter.format(-Math.round(day / 365), "year");
}
