import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { RelaySession } from "../types";
import { mergeSessionSnapshotIntoSessions, observedSessionEventCount, SESSIONS_QUERY_KEY, sessionTrailsSummary, summaryEventCountOf } from "../lib/sessionPollMerge";
import { isSessionStreamConnected } from "../lib/sessionStreamStatus";
import { applySessionEventUnchecked, applySessionEventsUnchecked } from "../lib/sessionEvents";
import { RELAY_POLL_INTERVALS_MS } from "../lib/relayPolling";
import { isTerminalSessionStatus } from "../lib/sessionEventStream";
import { readSessionDetails, removeSessionDetail, writeSessionDetail } from "../lib/sessionDetailCache";
import { workflowSnapshotDue } from "../lib/workflowRuns";
import { fetchSessionSnapshot, reconcileSessionSnapshot } from "../lib/sessionSnapshotQuery";
import { cacheThreadQueue, EMPTY_THREAD_QUEUE } from "../lib/threadQueue";

/**
 * Hydrate only the selected thread. Reuse account-scoped browser and memory
 * caches on return; stale details reconcile without clearing the transcript.
 * Reconcile status transitions, including a terminal
 * summary arriving before SSE. While the stream is down, a summary that has
 * seen events the cache lacks also refetches: the summary updates status but
 * not runs or rounds, so they would otherwise read stale until the stream
 * returns. A disconnected live thread also reconciles every 15 seconds,
 * and a settled thread every minute, since older pages are not polled.
 * Queued and unsettled execution notices also reconcile while SSE is connected:
 * command pickup, lease renewal, and finalization can change execution truth
 * without changing session status or emitting a new conversation event.
 * A workflow event the client cannot project (a step result, a retry) marks the
 * session as owing a snapshot, refetched on each tick until one clears it.
 */
export function useSessionDetail(sessionId: string | undefined, enabled: boolean, ownerId?: string) {
  const queryClient = useQueryClient();
  const forceRetry = useRef(false);
  const [readySessionId, setReadySessionId] = useState<string | undefined>(undefined);
  const [attempt, setAttempt] = useState(0);
  const [failure, setFailure] = useState<{ id: string; message: string } | null>(null);
  const retry = useCallback(() => {
    forceRetry.current = true;
    setFailure(null);
    setAttempt(value => value + 1);
  }, []);
  useEffect(() => {
    if (!sessionId || !enabled) return;
    const controller = new AbortController();
    const hydrationKey = ["relay", "session-hydration", sessionId] as const;
    type Hydration = { status: RelaySession["status"]; hydratedAt: number };
    let initial = queryClient.getQueryData<Hydration>(hydrationKey);
    let current = queryClient.getQueryData<RelaySession[]>(SESSIONS_QUERY_KEY)?.find(s => s.id === sessionId);
    const primeQueue = (snapshot: RelaySession) => {
      if (snapshot.transcriptRevision) {
        cacheThreadQueue(queryClient, sessionId, {
          ...(snapshot.messageQueue ?? EMPTY_THREAD_QUEUE), eventCount: observedSessionEventCount(snapshot),
        });
      }
    };
    if (!initial && ownerId) {
      const saved = readSessionDetails(ownerId).find(row => row.snapshot.id === sessionId);
      // A fresh list observation takes precedence over an older stored detail.
      if (saved && (!current || (saved.snapshot.updatedAt >= current.updatedAt
        && observedSessionEventCount(saved.snapshot) >= (summaryEventCountOf(current) ?? 0)))) {
        current = queryClient.setQueryData<RelaySession[]>(SESSIONS_QUERY_KEY, rows =>
          mergeSessionSnapshotIntoSessions(rows ?? [], current && summaryEventCountOf(current) !== undefined
            ? { ...saved.snapshot, execution: current.execution } : saved.snapshot, applySessionEventUnchecked, applySessionEventsUnchecked))
          ?.find(s => s.id === sessionId);
        if (current && observedSessionEventCount(current) >= observedSessionEventCount(saved.snapshot)) {
          initial = { status: current.status, hydratedAt: saved.hydratedAt };
          queryClient.setQueryData(hydrationKey, initial);
        }
      }
    }
    // Metadata alone is insufficient if the list evicted the actual detail.
    if (!current || sessionTrailsSummary(current)) initial = undefined;
    if (current && initial) primeQueue(current);
    let hydratedStatus = forceRetry.current ? undefined : initial?.status;
    forceRetry.current = false;
    setReadySessionId(hydratedStatus === undefined ? undefined : sessionId);
    let pending = false;
    let hydratedAt = initial?.hydratedAt ?? 0;
    let denied = false;
    const hydrate = async () => {
      if (pending || denied || controller.signal.aborted) return;
      const cached = queryClient.getQueryData<RelaySession[]>(SESSIONS_QUERY_KEY)?.find(s => s.id === sessionId);
      const trails = sessionTrailsSummary(cached)
        && !isSessionStreamConnected();
      // An older thread may be outside the summary poll's first page. When
      // SSE is down it has no other change signal, so reconcile it directly.
      const fallbackDue = !isSessionStreamConnected()
        && Date.now() - hydratedAt >= (isTerminalSessionStatus(cached?.status)
          ? 60_000 : RELAY_POLL_INTERVALS_MS.sessionsWhileStreaming);
      const executionPhase = cached?.execution?.phase;
      const executionDue = executionPhase !== undefined
        && executionPhase !== "running" && executionPhase !== "terminal"
        && Date.now() - hydratedAt >= RELAY_POLL_INTERVALS_MS.sessions;
      // Queue status changes need no conversation event, including the last
      // batch completing after artifact.created already reached SSE.
      const artifactIndexDue = (cached?.artifactIndexStatus?.pending ?? 0) > 0
        && Date.now() - hydratedAt >= RELAY_POLL_INTERVALS_MS.sessions;
      // Committed before it streams, so the next snapshot normally clears it.
      const workflowStale = workflowSnapshotDue(cached) !== undefined;
      if (hydratedStatus !== undefined && cached?.status === hydratedStatus && !trails && !fallbackDue && !executionDue && !workflowStale && !artifactIndexDue) return;
      pending = true;
      try {
        const snapshot = await fetchSessionSnapshot(queryClient, sessionId);
        const merged = await reconcileSessionSnapshot(queryClient, snapshot, controller.signal);
        // A shared request may have started before the list saw newer events.
        // Keep the fallback eligible until the cache has caught up.
        if (controller.signal.aborted || !merged || sessionTrailsSummary(merged)) return;
        hydratedStatus = merged.status;
        hydratedAt = Date.now();
        primeQueue(snapshot);
        queryClient.setQueryData(hydrationKey, { status: hydratedStatus, hydratedAt });
        setFailure(null);
        setReadySessionId(sessionId);
      } catch (error) {
        if (controller.signal.aborted) return;
        denied = error instanceof Error && "status" in error && [401, 403, 404].includes(Number(error.status));
        if (denied) {
          queryClient.removeQueries({ queryKey: hydrationKey, exact: true });
          if (ownerId) removeSessionDetail(ownerId, sessionId);
          setReadySessionId(undefined);
        }
        setFailure({ id: sessionId, message: error instanceof Error ? error.message : String(error) });
        // Transient failures retry on the next tick; access failures wait for
        // an explicit retry or a new selection.
      } finally {
        pending = false;
      }
    };
    const persist = () => {
      if (!ownerId || hydratedStatus === undefined || denied) return;
      const snapshot = queryClient.getQueryData<RelaySession[]>(SESSIONS_QUERY_KEY)?.find(s => s.id === sessionId);
      if (snapshot) writeSessionDetail(ownerId, { snapshot, hydratedAt });
    };
    void hydrate().then(persist);
    window.addEventListener("pagehide", persist);
    // The check is a cache read, but a hidden tab has nothing to reconcile for:
    // skip its ticks and catch up the moment the tab is shown again.
    const tick = () => { if (!document.hidden) void hydrate(); };
    const timer = window.setInterval(tick, RELAY_POLL_INTERVALS_MS.sessions);
    document.addEventListener("visibilitychange", tick);
    return () => {
      persist();
      window.removeEventListener("pagehide", persist);
      controller.abort();
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [enabled, queryClient, sessionId, attempt, ownerId]);
  return { ready: enabled && readySessionId === sessionId && !!sessionId, error: enabled && failure && failure.id === sessionId ? failure.message : null, retry };
}
