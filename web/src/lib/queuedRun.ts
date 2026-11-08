import type { RelaySession } from "../types.js";
import { formatRunDuration } from "./taskRuns.ts";

/** Why an admitted run has not started: the computer is not there to take
 *  it, or it is there and every slot it runs work in is taken. */
export type QueueCause = "offline" | "slot";

export type QueuedRun = {
  cause: QueueCause;
  /** When the run was admitted; null from a backend that does not say. */
  queuedAt: string | null;
};

/**
 * The open run of a thread that is waiting in line, or null.
 *
 * Only the backend's `queued` phase counts: the run is admitted and no
 * computer has taken it. Offline is the backend's heartbeat verdict, or the
 * rail's own knowledge that the pinned computer dropped away — the two read
 * the same liveness, the rail just has it sooner.
 */
export function queuedRun(
  session: Pick<RelaySession, "execution">,
  { nodeOffline = false }: { nodeOffline?: boolean } = {},
): QueuedRun | null {
  const execution = session.execution;
  if (execution?.phase !== "queued") return null;
  const offline = execution.computerOnline === false || nodeOffline;
  return { cause: offline ? "offline" : "slot", queuedAt: execution.queuedAt ?? null };
}

/**
 * How long a run has waited, as the run ledger writes durations ("3m",
 * "2h 30m"). The rail ticks once a minute, so it counts whole minutes and
 * stays silent through the first; the open thread ticks every second.
 */
export function queueWaitLabel(queuedAt: string | null, now: number, granularity: "minute" | "second"): string {
  if (!queuedAt) return "";
  const then = Date.parse(queuedAt);
  if (!Number.isFinite(then)) return "";
  const waited = Math.max(0, now - then);
  if (granularity === "second") return formatRunDuration(Math.floor(waited / 1000) * 1000);
  const minutes = Math.floor(waited / 60_000);
  return minutes < 1 ? "" : formatRunDuration(minutes * 60_000);
}
