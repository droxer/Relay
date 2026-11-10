export interface DashboardDateRange {
  start: string;
  end: string;
}

export type DashboardRange = DashboardDateRange | "all";
export type DashboardRangeSelection = DashboardPreset | "all" | "custom";
export type DashboardBucketSize = "day" | "month" | "year";

export type DashboardPreset = "7d" | "30d" | "month";

function localDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function dashboardPresetRange(preset: DashboardPreset, now = new Date()): DashboardDateRange {
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const start = new Date(end);
  if (preset === "month") {
    start.setDate(1);
    start.setMonth(start.getMonth() - 1);
    end.setDate(0);
  } else {
    start.setDate(start.getDate() - (preset === "7d" ? 6 : 29));
  }
  return { start: localDate(start), end: localDate(end) };
}

export function validDashboardRange(range: DashboardDateRange): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(range.start) || !/^\d{4}-\d{2}-\d{2}$/.test(range.end)) return false;
  if (range.start <= "0001-01-01" || range.end >= "9999-12-31") return false;
  const days = (Date.parse(range.end) - Date.parse(range.start)) / 86_400_000;
  return days >= 0 && days < 366;
}
