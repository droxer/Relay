import type { QueryClient } from "@tanstack/react-query";
import { getSession, type SessionSnapshotCache } from "../api";
import { readOlderTranscript } from "../api-client/sessions";
import type { RelaySession } from "../types";
import { applySessionEventUnchecked, applySessionEventsUnchecked } from "./sessionEvents";
import { mergeSessionSnapshotIntoSessions, observedSessionEventCount, SESSIONS_QUERY_KEY } from "./sessionPollMerge";

/** Detail hydration and an SSE failure share one in-flight HTTP read. The
 * merged sessions collection can advance through SSE. Keep the last HTTP
 * snapshot separately so the next read can validate its exact event prefix. */
export async function fetchSessionSnapshot(client: QueryClient, sessionId: string, options?: { reuseRecent?: boolean }) {
  const queryKey = ["session-snapshot", sessionId] as const;
  const result = await client.fetchQuery({
    queryKey,
    queryFn: async ({ signal }) => {
      const cache = { ...client.getQueryData<SessionSnapshotCache>(queryKey) };
      const snapshot = await getSession(sessionId, signal, cache);
      return { ...cache, snapshot };
    },
    staleTime: options?.reuseRecent && !client.isFetching({ queryKey, exact: true }) ? 5_000 : 0,
    gcTime: 2 * 60_000,
    structuralSharing: false,
    retry: false,
  });
  return result.snapshot;
}

export function fetchTranscriptPage(client: QueryClient, sessionId: string, before: number) {
  return client.fetchQuery({
    queryKey: ["transcript-history", sessionId, before],
    queryFn: ({ signal }) => readOlderTranscript(sessionId, before, signal),
    staleTime: 60_000,
    gcTime: 2 * 60_000,
    retry: false,
  });
}

/** Bridge a disjoint recent window before publishing it so the mounted
 * transcript stays readable during catch-up. The HTTP snapshot and its
 * validator remain untouched. */
export async function reconcileSessionSnapshot(client: QueryClient, snapshot: RelaySession, signal?: AbortSignal) {
  let start = snapshot.eventStart;
  const pages: RelaySession["events"][] = [];
  while (start !== undefined) {
    signal?.throwIfAborted();
    const existing = client.getQueryData<RelaySession[]>(SESSIONS_QUERY_KEY)?.find(row => row.id === snapshot.id);
    if (!existing && pages.length > 0) return undefined;
    if (!existing?.events.length || observedSessionEventCount(existing) >= start) break;
    const page = await fetchTranscriptPage(client, snapshot.id, start);
    pages.push(page.events);
    start = page.eventStart;
  }
  signal?.throwIfAborted();
  const contiguous = pages.length > 0
    ? { ...snapshot, eventStart: start, events: [...pages.reverse().flat(), ...snapshot.events] }
    : snapshot;
  return client.setQueryData<RelaySession[]>(SESSIONS_QUERY_KEY, rows =>
    mergeSessionSnapshotIntoSessions(rows ?? [], contiguous, applySessionEventUnchecked, applySessionEventsUnchecked))
    ?.find(row => row.id === snapshot.id);
}
