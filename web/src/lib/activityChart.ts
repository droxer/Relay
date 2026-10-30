export interface ActivityChartPoint {
  date: string;
  count: number;
  completed: number;
  failed: number;
}

/** One day's threads split by outcome. `other` is every thread that neither
 * completed nor failed — stopped, cancelled, or still open. */
export interface ActivityOutcome {
  date: string;
  completed: number;
  failed: number;
  other: number;
  total: number;
}

export interface ActivityTotals {
  completed: number;
  failed: number;
  other: number;
  total: number;
}

/** Keep the chart's minimum visual range separate from the value reported to
 * users. A scale floor is presentation state, not observed activity. */
export function activityChartMetrics(points: readonly ActivityChartPoint[]) {
  const dataPeak = Math.max(0, ...points.map((point) => point.count));
  return {
    dataPeak,
    scaleMax: niceScaleMax(dataPeak, 4),
  };
}

/** Clamp each bucket so a stack never outgrows the day's count, whatever the
 * backend reports: a bar taller than its total would lie about the axis. */
export function activityOutcomes(points: readonly ActivityChartPoint[]): ActivityOutcome[] {
  return points.map((point) => {
    const total = Math.max(0, point.count);
    const completed = Math.min(Math.max(0, point.completed), total);
    const failed = Math.min(Math.max(0, point.failed), total - completed);
    return { date: point.date, completed, failed, other: total - completed - failed, total };
  });
}

export function activityTotals(points: readonly ActivityChartPoint[]): ActivityTotals {
  return activityOutcomes(points).reduce<ActivityTotals>(
    (sum, day) => ({
      completed: sum.completed + day.completed,
      failed: sum.failed + day.failed,
      other: sum.other + day.other,
      total: sum.total + day.total,
    }),
    { completed: 0, failed: 0, other: 0, total: 0 },
  );
}

/** Completed share of the threads that reached an outcome, 0–1. Null when
 * nothing finished: a 0% would read as "everything failed". */
export function successRate(points: readonly ActivityChartPoint[]): number | null {
  const { completed, failed } = activityTotals(points);
  const finished = completed + failed;
  return finished > 0 ? completed / finished : null;
}

const GRID_STEPS = 4;
const NICE_STEPS = [1, 2, 2.5, 5, 10] as const;

/** A scale ceiling whose four gridlines land on round whole numbers: the
 * gridline step is the smallest 1/2/2.5/5 × 10ⁿ covering a quarter of the
 * peak (and of `floor`). The 2.5 step is used only where it stays whole (25,
 * 250, …), and the step never drops below one — these axes count things. */
export function niceScaleMax(peak: number, floor = 1): number {
  const target = Math.max(peak, floor, 0);
  const raw = target / GRID_STEPS;
  if (raw <= 1) return GRID_STEPS;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = NICE_STEPS
    .filter((candidate) => candidate !== 2.5 || magnitude >= 10)
    .map((candidate) => candidate * magnitude)
    .find((candidate) => candidate >= raw) ?? 10 * magnitude;
  return step * GRID_STEPS;
}

/** Gridline values from the baseline up, `steps` intervals. */
export function axisTicks(max: number, steps = GRID_STEPS): number[] {
  return Array.from({ length: steps + 1 }, (_, index) => (max * index) / steps);
}
