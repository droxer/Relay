import type { DashboardBucketSize } from "./dashboardRange.js";

const BUCKET_FORMATS: Record<DashboardBucketSize, Intl.DateTimeFormatOptions> = {
  day: { month: "short", day: "numeric" },
  month: { month: "short", year: "numeric" },
  year: { year: "numeric" },
};

/** Date-only chart buckets represent calendar days, not UTC instants. */
export function formatChartDate(value: string, locale: string, bucketSize: DashboardBucketSize = "day"): string {
  const calendarDate = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const date = calendarDate
    ? new Date(Number(calendarDate[1]), Number(calendarDate[2]) - 1, Number(calendarDate[3]))
    : new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(locale || undefined, BUCKET_FORMATS[bucketSize]).format(date);
}
