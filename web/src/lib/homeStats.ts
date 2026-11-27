import type { HomeStatsPeriod } from "../api-client/home.ts";
import type { RuntimeUsageRow, TokenCounts } from "../api-client/admin.ts";
import { formatCompact } from "./compactNumber.ts";
import { runtimeLabel } from "./runtimeLabel.ts";

export const HOME_STATS_PERIODS: readonly HomeStatsPeriod[] = ["week", "30d", "all"];

export interface TopRuntimeItem {
  agent: string;
  label: string;
  runs: number;
  formatted: string;
}

export interface TokenChartScale {
  max: number;
  ticks: number[];
}

/** Top runtimes by run count for the compact Agent runs stat caption. */
export function summarizeTopRuntimes(
  runtimes: readonly RuntimeUsageRow[],
  locale: string,
  limit = 2,
): { items: TopRuntimeItem[]; remainingRuns: number } {
  const named = runtimes.filter((row): row is RuntimeUsageRow & { agent: string } =>
    typeof row.agent === "string" && row.agent.length > 0 && row.runs > 0,
  );
  const items = named.slice(0, limit).map((row) => ({
    agent: row.agent,
    label: runtimeLabel(row.agent),
    runs: row.runs,
    formatted: formatCompact(row.runs, locale),
  }));
  const remainingRuns = named.slice(limit).reduce((sum, row) => sum + row.runs, 0);
  return { items, remainingRuns };
}

/** Round, evenly spaced integer y-axis ticks strictly above the data maximum.
 *  Zero is always the baseline; when every bucket is zero, returns a clean 0..4 scale. */
export function niceTokenScale(values: readonly number[], segments = 4): TokenChartScale {
  const peak = values.reduce((hi, value) => (Number.isFinite(value) && value > hi ? value : hi), 0);
  if (peak <= 0) {
    return { max: segments, ticks: Array.from({ length: segments + 1 }, (_, i) => i) };
  }
  // Keep at least 10% headroom so the tallest bar never touches the top gridline.
  const target = peak * 1.1;
  const rawStep = target / segments;
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const normalized = rawStep / magnitude;
  const niceFactor = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 2.5 ? 2.5 : normalized <= 5 ? 5 : 10;
  const step = Math.max(1, Math.round(niceFactor * magnitude));
  const max = step * segments;
  return {
    max,
    ticks: Array.from({ length: segments + 1 }, (_, i) => i * step),
  };
}

/** Choose evenly spaced x-axis label indices (never crowding or leaving a clipped stub). */
export function chartLabelIndices(count: number, maxLabels = 7): number[] {
  if (count <= 0) return [];
  if (count <= maxLabels) return Array.from({ length: count }, (_, i) => i);
  const step = Math.ceil((count - 1) / (maxLabels - 1));
  const indices: number[] = [];
  for (let i = 0; i < count; i += step) indices.push(i);
  return indices;
}

/** Format a local date window like "Nov 23 – Nov 27" for the personal stats header. */
export function formatStatsWindow(
  startDate: string | null | undefined,
  endDate: string | null | undefined,
  locale: string,
): string | null {
  if (!startDate || !endDate) return null;
  const start = new Date(`${startDate}T12:00:00`);
  const end = new Date(`${endDate}T12:00:00`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
  const fmt = new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" });
  if (startDate === endDate) return fmt.format(start);
  return `${fmt.format(start)} – ${fmt.format(end)}`;
}

/** Sum the fresh tokens across the displayed buckets so chart + KPI always agree. */
export function sumDailyFresh(daily: readonly (TokenCounts & { date: string })[]): number {
  return daily.reduce((total, day) => total + day.fresh, 0);
}
