import type { RelaySession } from "../types.js";
import { formatRunDuration } from "./taskRuns.ts";

/** The backend reports a dispatch wait; liveness can confirm an offline computer. */
export type QueueCause = "offline" | "dispatch";

export type QueuedRun = {
  cause: QueueCause;
  /** When the run was admitted; null from a backend that does not say. */
  queuedAt: string | null;
};

export type QueueReading = {
  /** The pinned computer is known to be gone (see `queuedRun`). */
  nodeOffline?: boolean;
  /** The reader's clock. Without one the queue reads as the backend says,
   *  with no grace. */
  now?: number;
};

/**
 * How long a run on a live computer may sit in `queued` before it is shown
 * as queued. A computer long-polls, so it takes a run almost at once, but the
 * web only learns that from the next session poll or the agent's first
 * output — seconds later. Inside this window the run reads as starting.
 */
export const QUEUE_GRACE_MS = 10_000;

/**
 * When a queued run's grace ends, or null when it has none: it is not
 * queued, its computer is known to be offline (waiting for a computer that
 * is gone is news at once), or the backend did not say when it was admitted.
 */
export function queueGraceEndsAt(
  session: Pick<RelaySession, "execution">,
  { nodeOffline = false }: Pick<QueueReading, "nodeOffline"> = {},
): number | null {
  const execution = session.execution;
  if (execution?.phase !== "queued" || execution.computerOnline === false || nodeOffline) return null;
  const admitted = execution.queuedAt ? Date.parse(execution.queuedAt) : Number.NaN;
  return Number.isFinite(admitted) ? admitted + QUEUE_GRACE_MS : null;
}

/** A queued run still inside its grace, which every surface shows as running. */
export function inQueueGrace(session: Pick<RelaySession, "execution">, { nodeOffline, now }: QueueReading = {}): boolean {
  const execution = session.execution;
  if (execution?.phase === "queued" && execution.queueWaitConfirmed !== undefined) {
    return !execution.queueWaitConfirmed && execution.computerOnline !== false && !nodeOffline;
  }
  // Older servers only provide the admission time.
  if (now === undefined) return false;
  const endsAt = queueGraceEndsAt(session, { nodeOffline });
  return endsAt !== null && now < endsAt;
}

/** The execution phase the thread surfaces show: the backend's, except that
 *  a run in its queue grace reads as running. */
export function shownExecutionPhase(
  session: Pick<RelaySession, "execution">,
  reading: QueueReading = {},
): NonNullable<RelaySession["execution"]>["phase"] | undefined {
  return inQueueGrace(session, reading) ? "running" : session.execution?.phase;
}

/** The earliest grace still ahead of `now` among these sessions, so a clock
 *  can wake exactly when a run turns from starting into queued. */
export function nextQueueGraceEnd(
  sessions: Iterable<Pick<RelaySession, "execution">>,
  now: number,
): number | null {
  let next: number | null = null;
  for (const session of sessions) {
    if (session.execution?.queueWaitConfirmed !== undefined) continue;
    const endsAt = queueGraceEndsAt(session);
    if (endsAt !== null && endsAt > now && (next === null || endsAt < next)) next = endsAt;
  }
  return next;
}

/**
 * The open run of a thread that is waiting in line, or null.
 *
 * Only the backend's `queued` phase counts: the run is admitted and no
 * computer has taken it. Offline is the backend's heartbeat verdict, or the
 * rail's own knowledge that the pinned computer dropped away — the two read
 * the same liveness, the rail just has it sooner. Given a clock, a run on a
 * live computer is not queued until its grace has passed.
 */
export function queuedRun(
  session: Pick<RelaySession, "execution">,
  reading: QueueReading = {},
): QueuedRun | null {
  const execution = session.execution;
  if (execution?.phase !== "queued" || inQueueGrace(session, reading)) return null;
  const offline = execution.computerOnline === false || Boolean(reading.nodeOffline);
  return { cause: offline ? "offline" : "dispatch", queuedAt: execution.queuedAt ?? null };
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
