import type { RelaySession, SessionSummary } from "../types.js";

type RelayEvent = RelaySession["events"][number];

function inflateSessionSummary(summary: SessionSummary): RelaySession {
  const { artifactCount, eventCount: _eventCount, runCount: _runCount, ...fields } = summary;
  return {
    ...fields,
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
  } as RelaySession;
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
    const { artifactCount, eventCount: _eventCount, runCount: _runCount, ...fields } = summary;
    return {
      ...existing,
      ...fields,
      workOutcome: summary.workOutcome ?? undefined,
      // A newer summary has no outcome text. Do not pair its new result with
      // an earlier round's reason while the detailed event stream catches up.
      finalOutcome: summary.eventCount > existing.events.length ? undefined : existing.finalOutcome,
      workspaceArtifactCount: artifactCount,
    } as RelaySession;
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
