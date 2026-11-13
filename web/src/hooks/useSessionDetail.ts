import { useCallback, useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { getSession } from "../api";
import type { RelaySession } from "../types";
import { mergeSessionSnapshotIntoSessions, sessionTrailsSummary, summaryEventCountOf } from "../lib/sessionPollMerge";
import { isSessionStreamConnected } from "../lib/sessionStreamStatus";
import { applySessionEventUnchecked, applySessionEventsUnchecked } from "../lib/sessionEvents";
import { RELAY_POLL_INTERVALS_MS } from "../lib/relayPolling";
import { isTerminalSessionStatus } from "../lib/sessionEventStream";

const SESSIONS_KEY = ["relay", "sessions"] as const;

/**
 * Hydrate selection and reconcile status transitions, including a terminal
 * summary arriving before SSE. While the stream is down, a summary that has
 * seen events the cache lacks also refetches: the summary updates status but
 * not runs or rounds, so they would otherwise read stale until the stream
 * returns. A disconnected live thread also reconciles every 15 seconds,
 * and a settled thread every minute, since older pages are not polled.
 * Queued and unsettled execution notices also reconcile while SSE is connected:
 * command pickup, lease renewal, and finalization can change execution truth
 * without changing session status or emitting a new conversation event.
 */
export function useSessionDetail(sessionId: string | undefined, enabled: boolean) {
  const queryClient = useQueryClient();
  const [attempt, setAttempt] = useState(0);
  const [failure, setFailure] = useState<{ id: string; message: string } | null>(null);
  const retry = useCallback(() => {
    setFailure(null);
    setAttempt(value => value + 1);
  }, []);
  useEffect(() => {
    if (!sessionId || !enabled) return;
    const controller = new AbortController();
    let hydratedStatus: RelaySession["status"] | undefined;
    let refetchedForCount: number | undefined;
    let pending = false;
    let hydratedAt = 0;
    let denied = false;
    const hydrate = async () => {
      if (pending || denied || controller.signal.aborted) return;
      const cached = queryClient.getQueryData<RelaySession[]>(SESSIONS_KEY)?.find(s => s.id === sessionId);
      const summaryCount = summaryEventCountOf(cached);
      const trails = sessionTrailsSummary(cached)
        && !isSessionStreamConnected()
        && summaryCount !== refetchedForCount;
      // An older thread may be outside the summary poll's first page. When
      // SSE is down it has no other change signal, so reconcile it directly.
      const fallbackDue = !isSessionStreamConnected()
        && Date.now() - hydratedAt >= (isTerminalSessionStatus(cached?.status)
          ? 60_000 : RELAY_POLL_INTERVALS_MS.sessionsWhileStreaming);
      const executionPhase = cached?.execution?.phase;
      const executionDue = executionPhase !== undefined
        && executionPhase !== "running" && executionPhase !== "terminal"
        && Date.now() - hydratedAt >= RELAY_POLL_INTERVALS_MS.sessions;
      if (hydratedStatus !== undefined && cached?.status === hydratedStatus && !trails && !fallbackDue && !executionDue) return;
      pending = true;
      try {
        const snapshot = await getSession(sessionId, controller.signal);
        if (controller.signal.aborted) return;
        hydratedStatus = snapshot.status;
        hydratedAt = Date.now();
        setFailure(null);
        refetchedForCount = summaryCount;
        queryClient.setQueryData<RelaySession[]>(SESSIONS_KEY, current =>
          mergeSessionSnapshotIntoSessions(current ?? [], snapshot, applySessionEventUnchecked, applySessionEventsUnchecked));
      } catch (error) {
        if (controller.signal.aborted) return;
        denied = error instanceof Error && "status" in error && [401, 403, 404].includes(Number(error.status));
        setFailure({ id: sessionId, message: error instanceof Error ? error.message : String(error) });
        // Transient failures retry on the next tick; access failures wait for
        // an explicit retry or a new selection.
      } finally {
        pending = false;
      }
    };
    void hydrate();
    // The check is a cache read, but a hidden tab has nothing to reconcile for:
    // skip its ticks and catch up the moment the tab is shown again.
    const tick = () => { if (!document.hidden) void hydrate(); };
    const timer = window.setInterval(tick, RELAY_POLL_INTERVALS_MS.sessions);
    document.addEventListener("visibilitychange", tick);
    return () => {
      controller.abort();
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [enabled, queryClient, sessionId, attempt]);
  return { error: enabled && failure && failure.id === sessionId ? failure.message : null, retry };
}
