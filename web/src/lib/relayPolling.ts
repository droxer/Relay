import type { TaskStatus } from "relay-core";

/* Poll budgets. Every interval here is a React Query refetchInterval, so none
   of them run in a hidden tab (refetchIntervalInBackground stays false). */
export const RELAY_POLL_INTERVALS_MS = {
  sandboxes: 15_000,
  nodes: 3_000,
  sessions: 3_000,
  /** The open thread's SSE tail pushes its events, so the list only has to
      catch the other threads' status changes. */
  sessionsWhileStreaming: 10_000,
  tasks: 3_000,
  /** Projects change through the owner's own edits (which write the cache)
      far more than in the background. */
  projects: 30_000,
  /** Agents and teams only drift through node-reported availability. */
  agents: 30_000,
  teams: 30_000,
  /** A settled task record with no list row to signal a retry or reopen. */
  settledTaskRecord: 30_000,
} as const;

/** How long a mounted roster read is reused before a new mount refetches it. */
export const ROSTER_STALE_TIME_MS = 10_000;

export function sessionsPollIntervalMs(streamConnected: boolean): number {
  return streamConnected ? RELAY_POLL_INTERVALS_MS.sessionsWhileStreaming : RELAY_POLL_INTERVALS_MS.sessions;
}

/**
 * A task status nothing will move without a person: `done`, or `blocked`
 * (a failed run awaiting retry). Mirrors runOutcome's terminal outcomes.
 */
export function isSettledTaskStatus(status: TaskStatus | undefined): boolean {
  return status === "done" || status === "blocked";
}

/**
 * A task record polls until it settles; after that the polled list row is its
 * change signal. A record the list does not carry (a deep link past the list's
 * page) has no such signal, so it keeps a slow poll instead of stopping.
 */
export function taskRecordPollIntervalMs(status: TaskStatus | undefined, hasListRow = true): number | false {
  if (!isSettledTaskStatus(status)) return RELAY_POLL_INTERVALS_MS.tasks;
  return hasListRow ? false : RELAY_POLL_INTERVALS_MS.settledTaskRecord;
}

/**
 * The task workspace's "waiting on another thread" note: watched while it is
 * showing (so it clears) and while the task can still start work; a settled
 * task with no note has nothing left to watch. An unknown task keeps polling.
 */
export function taskWorkspaceStatusPollIntervalMs(input: {
  waiting: boolean | undefined;
  taskStatus: TaskStatus | undefined;
}): number | false {
  if (input.waiting) return RELAY_POLL_INTERVALS_MS.tasks;
  return isSettledTaskStatus(input.taskStatus) ? false : RELAY_POLL_INTERVALS_MS.tasks;
}
