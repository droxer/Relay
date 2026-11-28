import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { RelaySession } from "../types";
import { SESSIONS_QUERY_KEY } from "../lib/sessionPollMerge";
import { fetchTranscriptPage } from "../lib/sessionSnapshotQuery";

export function useOlderTranscript(sessionId: string | undefined) {
  const client = useQueryClient();
  const active = useRef(sessionId);
  const requests = useRef(new Set<string>());
  const [pendingIds, setPendingIds] = useState<ReadonlySet<string>>(() => new Set());
  const [failedId, setFailedId] = useState<string>();
  useLayoutEffect(() => {
    active.current = sessionId;
    return () => { active.current = undefined; };
  }, [sessionId]);

  const load = useCallback(async (beforeInsert: () => void) => {
    if (!sessionId || requests.current.has(sessionId)) return;
    const getSession = () => client.getQueryData<RelaySession[]>(SESSIONS_QUERY_KEY)?.find(row => row.id === sessionId);
    const before = getSession()?.eventStart;
    if (!before) return;
    requests.current.add(sessionId);
    setPendingIds(new Set(requests.current));
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
      requests.current.delete(sessionId);
      setPendingIds(new Set(requests.current));
    }
  }, [client, sessionId]);

  return { load, pending: !!sessionId && pendingIds.has(sessionId), failed: !!sessionId && failedId === sessionId };
}
