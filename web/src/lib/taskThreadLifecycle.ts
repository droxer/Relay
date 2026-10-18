import type { RelayTaskEvent, TaskStatus } from "../types.js";

/**
 * The task's lifecycle, as a thread reads it.
 *
 * A task thread used to show its conversation and nothing of the task it was
 * doing: the work went Ready → In progress → Review → Completed (or stopped
 * to ask, or blocked) and the transcript never said so — the reader had to
 * leave for the task record to learn where it stood. This projection turns the
 * task's event log into the status changes that belong to ONE thread, which
 * the thread's side panel lists as the task's timeline — beside the
 * conversation rather than interleaved with its turns.
 *
 * The lib stays pure (no i18n, no React) so the windowing rule is testable;
 * the wording lives in `TaskStatusTimeline`.
 */
export type LifecycleActor = "you" | "teammate" | "relay";

export type LifecycleMarker = {
  /** The event id — stable across refetches, so it keys the row. */
  id: string;
  timestamp: string;
  from: TaskStatus;
  to: TaskStatus;
  /** Who moved it: the reader, another person, or Relay itself. */
  actor: LifecycleActor;
  /** Why, when the event says: a blocker, a parked wait's reason. */
  reason?: string;
};

type ThreadWindow = {
  sessionId: string;
  /** The thread's creation time — its goal message's timestamp. */
  sessionCreatedAt: string;
  currentUserId?: string;
};

type Transition = LifecycleMarker & { sessionId?: string };

function actorFor(actorUserId: string | undefined, currentUserId: string | undefined): LifecycleActor {
  if (!actorUserId) return "relay";
  return actorUserId === currentUserId ? "you" : "teammate";
}

function transitionsOf(events: readonly RelayTaskEvent[], currentUserId?: string): Transition[] {
  const ordered = [...events].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const transitions: Transition[] = [];
  let status: TaskStatus = "backlog";
  for (const event of ordered) {
    let next: Omit<Transition, "from"> | null = null;
    if (event.type === "task.status") {
      next = {
        id: event.id,
        timestamp: event.timestamp,
        to: event.status,
        actor: actorFor(event.actorUserId, currentUserId),
        ...(event.reason ? { reason: event.reason } : {}),
        ...(event.sessionId ? { sessionId: event.sessionId } : {}),
      };
    } else if (event.type === "task.execution.claimed") {
      // A claim is Relay taking the task for a run; the reducer lands it on
      // `assigned` whatever it was.
      next = { id: event.id, timestamp: event.timestamp, to: "assigned", actor: "relay" };
    }
    if (!next || next.to === status) continue;
    transitions.push({ ...next, from: status });
    status = next.to;
  }
  return transitions;
}

/**
 * When a later thread took over this task, the task's moves after that belong
 * to the later thread. Returns that hand-over time, or undefined while this is
 * the task's newest thread.
 */
function windowEnd(events: readonly RelayTaskEvent[], window: ThreadWindow): string | undefined {
  const later = events
    .filter((event): event is Extract<RelayTaskEvent, { type: "task.session_linked" }> =>
      event.type === "task.session_linked"
      && event.sessionId !== window.sessionId
      && event.timestamp > window.sessionCreatedAt)
    .map((event) => event.timestamp)
    .sort();
  return later[0];
}

/**
 * The status changes this thread should show, oldest first.
 *
 * Everything from the thread's creation until a later thread took the task
 * over, plus the lead-in that queued this run: the moves since the task last
 * became Ready (or, failing that, the one move just before the thread), so the
 * timeline opens on how the work got here rather than mid-stride.
 */
export function threadLifecycleMarkers(
  events: readonly RelayTaskEvent[],
  window: ThreadWindow,
): LifecycleMarker[] {
  const transitions = transitionsOf(events, window.currentUserId);
  const end = windowEnd(events, window);
  const firstInside = transitions.findIndex((item) => item.timestamp >= window.sessionCreatedAt);
  const insideStart = firstInside === -1 ? transitions.length : firstInside;
  const queued = transitions.slice(0, insideStart).map((item) => item.to).lastIndexOf("assigned");
  const leadStart = queued !== -1 ? queued : Math.max(0, insideStart - 1);
  return transitions
    .slice(leadStart)
    .filter((item) => !end || item.timestamp < end)
    // A wait parked in another thread is answered there, not here.
    .filter((item) => !item.sessionId || item.sessionId === window.sessionId)
    .map((item): LifecycleMarker => ({
      id: item.id,
      timestamp: item.timestamp,
      from: item.from,
      to: item.to,
      actor: item.actor,
      ...(item.reason ? { reason: item.reason } : {}),
    }));
}
