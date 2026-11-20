import type { TaskStatus } from "relay-core";

/* Poll budgets. Every interval here is a React Query refetchInterval, so none
   of them run in a hidden tab (refetchIntervalInBackground stays false). */
export const RELAY_POLL_INTERVALS_MS = {
  sandboxes: 30_000,
  /** Computers change through registration and liveness, which the backend
      derives with a 60 s timeout; nothing on screen needs them faster than
      this. */
  nodes: 15_000,
  sessions: 5_000,
  /** The open thread's SSE tail pushes its events, so the list only has to
      catch the other threads' status changes. */
  sessionsWhileStreaming: 15_000,
  /** Task status moves on a round's closeout, not at stream rate. */
  tasks: 10_000,
  /** Projects change through the owner's own edits, which invalidate the
      cache; the poll is only a backstop for someone else's edit. */
  projects: 300_000,
  /** Agents and teams change through roster mutations (which invalidate) and
      node-reported availability, which `useRosterAvailabilityRefresh` follows
      from the nodes poll. The poll is only a backstop. */
  agents: 300_000,
  teams: 300_000,
  /** The notification inbox. The bell is a summary, not a live feed, and a
      run's own surfaces already show it finishing in real time. */
  notifications: 30_000,
  /** A settled task record with no list row to signal a retry or reopen. */
  settledTaskRecord: 30_000,
  /** Discover new automation occurrences even when all known runs settled. */
  runDiscovery: 30_000,
} as const;

/** How long a mounted roster read is reused before a new mount refetches it. */
export const ROSTER_STALE_TIME_MS = 30_000;

/**
 * What about the computers decides whether an agent is available: each
 * computer's liveness and its runtimes' readiness. The roster is refetched
 * only when this changes, so a steady nodes poll costs the roster nothing.
 */
export function nodeAvailabilitySignature(nodes: readonly NodeAvailabilityInput[]): string {
  return nodes
    .map((node) => {
      const runtimes = Object.entries(node.agents ?? {})
        .map(([agent, status]) => `${agent}=${status}`)
        .sort()
        .join(",");
      return `${node.id}:${node.status}:${node.online ? 1 : 0}${node.dispatchable === false ? 0 : 1}:${runtimes}`;
    })
    .sort()
    .join("|");
}

export interface NodeAvailabilityInput {
  id: string;
  status?: string;
  online: boolean;
  dispatchable?: boolean;
  agents?: Partial<Record<string, string>>;
}

export function sessionsPollIntervalMs(streamConnected: boolean): number {
  return streamConnected ? RELAY_POLL_INTERVALS_MS.sessionsWhileStreaming : RELAY_POLL_INTERVALS_MS.sessions;
}

/**
 * A task status nothing will move without a person: `done`, or `blocked`
 * (a failed run awaiting retry). Mirrors runOutcome's terminal outcomes.
 */
export function isSettledTaskStatus(status: TaskStatus | undefined): boolean {
  return status === "done" || status === "cancelled" || status === "blocked";
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
