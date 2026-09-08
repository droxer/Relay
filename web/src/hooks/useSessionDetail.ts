import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { getSession } from "../api";
import type { RelaySession } from "../types";
import { mergeSessionSnapshotIntoSessions } from "../lib/sessionPollMerge";
import { applySessionEventUnchecked } from "../lib/sessionEvents";
import { RELAY_POLL_INTERVALS_MS } from "../lib/relayPolling";

const SESSIONS_KEY = ["relay", "sessions"] as const;

/** Hydrate selection and reconcile status transitions, including a terminal summary arriving before SSE. */
export function useSessionDetail(sessionId: string | undefined, enabled: boolean): void {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!sessionId || !enabled) return;
    const controller = new AbortController();
    let hydratedStatus: RelaySession["status"] | undefined;
    let pending = false;
    const hydrate = async () => {
      if (pending || controller.signal.aborted) return;
      const cached = queryClient.getQueryData<RelaySession[]>(SESSIONS_KEY)?.find(s => s.id === sessionId);
      if (hydratedStatus !== undefined && cached?.status === hydratedStatus) return;
      pending = true;
      try {
        const snapshot = await getSession(sessionId, controller.signal);
        if (controller.signal.aborted) return;
        hydratedStatus = snapshot.status;
        queryClient.setQueryData<RelaySession[]>(SESSIONS_KEY, current =>
          mergeSessionSnapshotIntoSessions(current ?? [], snapshot, applySessionEventUnchecked));
      } catch {
        // Retry failed hydration on the next reconciliation tick.
      } finally {
        pending = false;
      }
    };
    void hydrate();
    const timer = window.setInterval(() => void hydrate(), RELAY_POLL_INTERVALS_MS.sessions);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [enabled, queryClient, sessionId]);
}
