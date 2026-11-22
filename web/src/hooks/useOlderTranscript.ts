import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { RelaySession } from "../types";
import { SESSIONS_QUERY_KEY } from "../lib/sessionPollMerge";
import { fetchTranscriptPage } from "../lib/sessionSnapshotQuery";

export function useOlderTranscript(sessionId: string | undefined) {
  const client = useQueryClient();
  const active = useRef(sessionId);
  const request = useRef<{ id: string } | undefined>(undefined);
  const [pendingId, setPendingId] = useState<string>();
  const [failedId, setFailedId] = useState<string>();
  useLayoutEffect(() => {
    active.current = sessionId;
    return () => { active.current = undefined; };
  }, [sessionId]);

  const load = useCallback(async (beforeInsert: () => void) => {
    if (!sessionId || request.current?.id === sessionId) return;
    const getSession = () => client.getQueryData<RelaySession[]>(SESSIONS_QUERY_KEY)?.find(row => row.id === sessionId);
    const before = getSession()?.eventStart;
    if (!before) return;
    const ticket = { id: sessionId };
    request.current = ticket;
    setPendingId(sessionId);
    setFailedId(undefined);
    try {
      const page = await fetchTranscriptPage(client, sessionId, before);
      if (active.current !== sessionId || getSession()?.eventStart !== before) return;
      beforeInsert();
      client.setQueryData<RelaySession[]>(SESSIONS_QUERY_KEY, rows => rows?.map(row =>
        row.id === sessionId && row.eventStart === before
          ? { ...row, eventStart: page.eventStart, events: [...page.events, ...row.events] }
          : row));
    } catch {
      if (active.current === sessionId) setFailedId(sessionId);
    } finally {
      if (request.current === ticket) {
        request.current = undefined;
        setPendingId(undefined);
      }
    }
  }, [client, sessionId]);

  return { load, pending: !!sessionId && pendingId === sessionId, failed: !!sessionId && failedId === sessionId };
}
