import type { TaskRun } from "../types.js";

/**
 * What a run's row says at a glance.
 *
 * The task status vocabulary is about where work sits on the board; a ledger
 * asks a narrower question — did this run land, is it going, or did it never
 * get going. Collapsing statuses here keeps that judgement in one place
 * instead of in every badge that renders a row.
 */
export type RunOutcome = "done" | "failed" | "running" | "pending";

export function runOutcome(run: TaskRun): RunOutcome {
  if (run.status === "done") return "done";
  if (run.status === "blocked") return "failed";
  if (run.status === "running") return "running";
  // `review` and `waiting_for_human` are a finished agent turn waiting on a
  // person — the run itself is still open, so it reads as running.
  if (run.status === "review" || run.status === "waiting_for_human") return "running";
  return "pending";
}

/**
 * How long the run took, in milliseconds — null when it has not started, has
 * not finished, or carries timestamps that cannot be ordered.
 */
export function runDurationMs(run: TaskRun): number | null {
  if (!run.startedAt || !run.endedAt) return null;
  const started = Date.parse(run.startedAt);
  const ended = Date.parse(run.endedAt);
  if (Number.isNaN(started) || Number.isNaN(ended) || ended < started) return null;
  return ended - started;
}

const pad2 = (value: number) => String(value).padStart(2, "0");

/**
 * Relay's one duration voice: `47s`, `3m 12s`, `1h 02m` — every receipt,
 * ledger row, and live elapsed counter writes a duration through here.
 * Seconds stay under an hour (a 3-minute run and a 3m 50s one are different
 * runs); past it the minutes are padded so a column of times aligns.
 *
 * Deliberately unlocalized digits with unit suffixes — the ledger's rows are
 * scanned vertically, and a spelled-out duration breaks the column.
 */
export function formatRunDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return seconds % 60 ? `${minutes}m ${pad2(seconds % 60)}s` : `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${pad2(minutes % 60)}m`;
}
