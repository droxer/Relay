import type { RelaySession, SessionSummary } from "../types.js";
import { omit } from "./omit.ts";

type RelayEvent = RelaySession["events"][number];

/**
 * A session as the summary poll leaves it. `summaryEventCount` is the event
 * count the last summary reported: the summary carries status but not the
 * runs or rounds, so a session whose events trail that count holds stale run
 * data until its detail is fetched again. A fetched snapshot or streamed
 * events clear the gap.
 */
type PolledSession = RelaySession & { summaryEventCount?: number };

/** Whether the poll has seen events this cached session does not hold yet. */
export function sessionTrailsSummary(session: RelaySession | undefined): boolean {
  const count = (session as PolledSession | undefined)?.summaryEventCount;
  return session !== undefined && count !== undefined && count > session.events.length;
}

/** The summary's event count, kept so a stale session can be refetched. */
export function summaryEventCountOf(session: RelaySession | undefined): number | undefined {
  return (session as PolledSession | undefined)?.summaryEventCount;
}

function inflateSessionSummary(summary: SessionSummary): RelaySession {
  const { artifactCount, ...fields } = omit(summary, "eventCount", "runCount");
  return {
    ...fields,
    summaryEventCount: summary.eventCount,
    workOutcome: summary.workOutcome ?? undefined,
    participants: ["human"],
    agentRuns: [],
    // A summary carries the count but not the records — see the field's note
    // on RelaySession. The backlog's result line needs only the number.
    workspaceArtifactCount: artifactCount,
    artifacts: [],
    decisions: [],
    collaborationRounds: [],
    events: [],
  } as PolledSession;
}

export function mergeSessionSummaries(
  current: RelaySession[],
  summaries: SessionSummary[],
): RelaySession[] {
  const byId = new Map(current.map((session) => [session.id, session]));
  return summaries.map((summary) => {
    const existing = byId.get(summary.id);
    if (!existing) return inflateSessionSummary(summary);
    // A summary request can start before an SSE frame is committed and return
    // afterward. Never roll event-derived state backward in that race.
    if (summary.eventCount < existing.events.length) return existing;
    const { artifactCount, ...fields } = omit(summary, "eventCount", "runCount");
    return {
      ...existing,
      ...fields,
      summaryEventCount: summary.eventCount,
      workOutcome: summary.workOutcome ?? undefined,
      // A newer summary has no outcome text. Do not pair its new result with
      // an earlier round's reason while the detailed event stream catches up.
      finalOutcome: summary.eventCount > existing.events.length ? undefined : existing.finalOutcome,
      workspaceArtifactCount: artifactCount,
    } as PolledSession;
  });
}

export function mergeSessionSnapshotIntoSessions(
  current: RelaySession[],
  snapshot: RelaySession,
  applyEvent: (session: RelaySession, event: RelayEvent) => RelaySession = (session, event) => ({
    ...session,
    updatedAt: event.timestamp,
    events: [...session.events, event],
  }),
): RelaySession[] {
  const index = current.findIndex((session) => session.id === snapshot.id);
  if (index < 0) return [snapshot, ...current];

  const snapshotIds = new Set(snapshot.events.map((event) => event.id));
  const merged = current[index].events
    .filter((event) => !snapshotIds.has(event.id))
    .reduce(applyEvent, snapshot);
  if (merged === current[index]) return current;
  const next = [...current];
  next[index] = merged;
  return next;
}
