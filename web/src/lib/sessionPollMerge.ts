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

/** Threads per page of the thread list: the polled first page and each older
 *  page the rail loads as the reader scrolls. */
export const THREAD_PAGE_SIZE = 20;

/**
 * The polled first page folded into the loaded list. Older pages the reader
 * scrolled to stay: a session older than the page's last row was not in the
 * page's range, so its absence says nothing. One within the range that the
 * page no longer lists is gone (deleted, or no longer this user's) and drops,
 * as it did when the poll returned the whole list. Entries changed since the
 * request began survive until a later poll can reconcile them. `hasOlder` is
 * false when the page was the whole list.
 */
export function mergeSessionHeadPage(
  current: RelaySession[],
  summaries: SessionSummary[],
  hasOlder: boolean,
  atRequestStart: readonly RelaySession[] = current,
): RelaySession[] {
  const head = mergeSessionSummaries(current, summaries);
  const last = summaries.at(-1);
  const headIds = new Set(head.map((session) => session.id));
  const before = new Map(atRequestStart.map(session => [session.id, session]));
  const boundary = last ? Date.parse(last.updatedAt) : 0;
  // Absence only describes the state when the request began. A streamed
  // update, detail fetch, or newly created thread may have moved since then.
  // Reconcile those entries on the next poll rather than discarding live state.
  const older = current.filter((session) =>
    !headIds.has(session.id) && (before.get(session.id) !== session
      || (hasOlder && last && !(Date.parse(session.updatedAt) > boundary))));
  return older.length > 0 ? [...head, ...older] : head;
}

/** An older page appended below the loaded list. A session already loaded
 *  keeps its cached record: the cache is at least as new as the page. */
export function appendOlderSessionPage(
  current: RelaySession[],
  summaries: SessionSummary[],
): RelaySession[] {
  const known = new Set(current.map((session) => session.id));
  const fresh = summaries.filter((summary) => !known.has(summary.id));
  return fresh.length > 0 ? [...current, ...mergeSessionSummaries([], fresh)] : current;
}

export function mergeSessionSnapshotIntoSessions(
  current: RelaySession[],
  snapshot: RelaySession,
  applyEvent?: (session: RelaySession, event: RelayEvent) => RelaySession,
  applyEvents?: (session: RelaySession, events: RelayEvent[]) => RelaySession,
): RelaySession[] {
  const index = current.findIndex((session) => session.id === snapshot.id);
  if (index < 0) return [snapshot, ...current];

  const snapshotIds = new Set(snapshot.events.map((event) => event.id));
  const missing = current[index].events.filter((event) => !snapshotIds.has(event.id));
  // Replay the entire suffix together: per-event replay copies the growing
  // event array once per delta when a slow snapshot trails the live stream.
  const merged = missing.length === 0 ? snapshot : applyEvents
    ? applyEvents(snapshot, missing)
    : applyEvent ? missing.reduce(applyEvent, snapshot)
    : { ...snapshot, updatedAt: missing.at(-1)!.timestamp, events: [...snapshot.events, ...missing] };
  if (merged === current[index]) return current;
  const next = [...current];
  next[index] = merged;
  return next;
}
