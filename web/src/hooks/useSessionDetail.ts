import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { getSession } from "../api";
import type { RelaySession } from "../types";
import { mergeSessionSnapshotIntoSessions, sessionTrailsSummary, summaryEventCountOf } from "../lib/sessionPollMerge";
import { isSessionStreamConnected } from "../lib/sessionStreamStatus";
import { applySessionEventUnchecked } from "../lib/sessionEvents";
import { RELAY_POLL_INTERVALS_MS } from "../lib/relayPolling";

const SESSIONS_KEY = ["relay", "sessions"] as const;

/**
 * Hydrate selection and reconcile status transitions, including a terminal
 * summary arriving before SSE. While the stream is down, a summary that has
 * seen events the cache lacks also refetches: the summary updates status but
 * not runs or rounds, so they would otherwise read stale until the stream
 * returns. One refetch per summary count, so a count the detail cannot reach
 * never loops.
 */
export function useSessionDetail(sessionId: string | undefined, enabled: boolean): void {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!sessionId || !enabled) return;
    const controller = new AbortController();
    let hydratedStatus: RelaySession["status"] | undefined;
    let refetchedForCount: number | undefined;
    let pending = false;
    const hydrate = async () => {
      if (pending || controller.signal.aborted) return;
      const cached = queryClient.getQueryData<RelaySession[]>(SESSIONS_KEY)?.find(s => s.id === sessionId);
      const summaryCount = summaryEventCountOf(cached);
      const trails = sessionTrailsSummary(cached)
        && !isSessionStreamConnected()
        && summaryCount !== refetchedForCount;
      if (hydratedStatus !== undefined && cached?.status === hydratedStatus && !trails) return;
      pending = true;
      try {
        const snapshot = await getSession(sessionId, controller.signal);
        if (controller.signal.aborted) return;
        hydratedStatus = snapshot.status;
        refetchedForCount = summaryCount;
        queryClient.setQueryData<RelaySession[]>(SESSIONS_KEY, current =>
          mergeSessionSnapshotIntoSessions(current ?? [], snapshot, applySessionEventUnchecked));
      } catch {
        // Retry failed hydration on the next reconciliation tick.
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
  }, [enabled, queryClient, sessionId]);
}
