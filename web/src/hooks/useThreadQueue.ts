import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { useIsMutating, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ComposerHandle } from "../components/composer/Composer";
import { clearComposerDraft, restoreComposerDraft } from "./useComposer";
import { apiJson } from "../api-client/client";
import { THREAD_QUEUE_QUERY_KEY, type QueuedMessage, type QueueAddress } from "../lib/threadQueue";
import { NODES_QUERY_KEY, SESSIONS_QUERY_KEY, TASKS_QUERY_KEY } from "./useRelayData";

type QueueState = { messages: QueuedMessage[]; paused: boolean; sending?: string; error?: string; removed?: { message: QueuedMessage; beforeId: string | null; removedAt?: string } };
type QueueChange = {
  queueKey: string;
  threadId: string;
  action: string;
  id?: string;
  text?: string;
  address?: QueueAddress;
};
const EMPTY: QueueState = { messages: [], paused: false };
const ACTIVE_QUEUE_POLL_MS = 1_000;
const EMPTY_RUNNING_QUEUE_POLL_MS = 5_000;
const IDLE_QUEUE_POLL_MS = 30_000;

/** The server owns ordering and dispatch; no open browser is required. */
export function useThreadQueue({ queueKey, threadId, running, awaitsPerson, composerRef }: {
  queueKey: string;
  threadId?: string;
  running: boolean;
  awaitsPerson: boolean;
  composerRef: RefObject<ComposerHandle | null>;
}) {
  const { t } = useTranslation();
  const client = useQueryClient();
  const [errorState, setErrorState] = useState<{ key: string; message: string | null } | null>(null);
  const error = errorState?.key === queueKey ? errorState.message : null;
  const setError = useCallback((message: string | null) => setErrorState({ key: queueKey, message }), [queueKey]);
  const unsaved = useRef(new Map<string, QueuedMessage>());
  const key = [...THREAD_QUEUE_QUERY_KEY, threadId ?? null];
  const mutationKey = [...key, "change"];
  const pending = useIsMutating({ mutationKey, exact: true }) > 0;
  const { mutateAsync: mutateQueue } = useMutation({
    mutationKey,
    mutationFn: ({ threadId, action, id, text, address }: QueueChange) => apiJson<QueueState>(
      `/threads/${encodeURIComponent(threadId)}/queue`,
      { method: "POST", body: { action, id, text, ...address } },
    ),
    onSuccess: async (updated, { threadId, queueKey, action, text }) => {
      const queryKey = [...THREAD_QUEUE_QUERY_KEY, threadId];
      // A GET started before this write can still carry a pre-mutation queue.
      // Publish the receipt immediately. Later polls reconcile other writers.
      await client.cancelQueries({ queryKey, exact: true });
      client.setQueryData(queryKey, updated);
      if (action === "enqueue" && text !== undefined) clearComposerDraft(queueKey, text);
    },
  });
  const path = `/threads/${encodeURIComponent(threadId ?? "")}/queue`;
  const query = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => apiJson<QueueState>(path, { signal }),
    enabled: !!threadId,
    staleTime: ACTIVE_QUEUE_POLL_MS,
    // Own actions write the acknowledged state into the cache. The shorter
    // interval is for a message that can dispatch, not just a running Agent.
    refetchInterval: ({ state }) => {
      if (pending) return false;
      if (state.data?.messages?.length || state.data?.sending) return ACTIVE_QUEUE_POLL_MS;
      return running ? EMPTY_RUNNING_QUEUE_POLL_MS : IDLE_QUEUE_POLL_MS;
    },
    refetchOnWindowFocus: !pending,
  });
  const state = query.data?.messages ? query.data : EMPTY;
  const activeKey = useRef(queueKey);
  useLayoutEffect(() => { activeKey.current = queueKey; }, [queueKey]);
  const change = useCallback(async (action: string, id?: string, text?: string, address?: QueueAddress) => {
    // The account's mutation cache owns the lock, so navigating away and back
    // to this Thread cannot start a second write while its first is pending.
    if (!threadId || client.isMutating({ mutationKey: [...THREAD_QUEUE_QUERY_KEY, threadId, "change"], exact: true })) return false;
    try {
      await mutateQueue({ threadId, queueKey, action, id, text, address });
      if (activeKey.current === queueKey) setError(null);
      return true;
    } catch (cause) {
      if (activeKey.current === queueKey) setError(queueErrorKey(cause));
      return false;
    }
  }, [threadId, queueKey, client, mutateQueue, setError]);

  // Transfer legacy unsent text only after server acknowledgement. Stable IDs
  // make retries safe if the tab closes halfway through migration.
  useEffect(() => {
    if (!threadId) return;
    let stopped = false;
    void (async () => {
      const storageKey = `relay-web.queue:${queueKey}`;
      try {
        const legacy: QueuedMessage[] = JSON.parse(sessionStorage.getItem(storageKey) ?? "[]");
        if (!Array.isArray(legacy) || !legacy.length) return;
        for (const message of legacy) {
          if (stopped) return;
          if (!(await change("import", message.id, message.text))) return;
        }
        sessionStorage.removeItem(storageKey);
      } catch { /* Keep legacy text if storage is unavailable or malformed. */ }
    })();
    return () => { stopped = true; };
  }, [threadId, queueKey, change]);

  const enqueue = useCallback(async (text: string, address: QueueAddress = {}) => {
    const previous = unsaved.current.get(queueKey);
    const sameAddress = JSON.stringify([previous?.addressAgentIds, previous?.addressTeamId])
      === JSON.stringify([address.addressAgentIds, address.addressTeamId]);
    const message = previous?.text === text && sameAddress ? previous : { text, ...address, id: `q_${crypto.randomUUID()}` };
    unsaved.current.set(queueKey, message);
    const accepted = await change("enqueue", message.id, text, address);
    if (accepted) unsaved.current.delete(queueKey);
    return accepted;
  }, [change, queueKey]);
  const remove = useCallback((id: string) => { void change("remove", id); }, [change]);
  const undoRemove = useCallback(() => { if (state.removed) void change("undo_remove", state.removed.message.id); }, [change, state.removed]);
  const edit = useCallback(async (id: string) => {
    const message = state.messages.find(item => item.id === id);
    const composer = composerRef.current;
    if (!message || !composer || !(await change("edit", id))) return;
    if (activeKey.current !== queueKey) { restoreComposerDraft(queueKey, message.text); return; }
    const draft = composer.getText().trim();
    composer.setText(draft ? `${draft}\n\n${message.text}` : message.text);
    composer.focus();
  }, [state.messages, composerRef, change, queueKey]);
  const steer = useCallback(async (id: string) => {
    if (await change(running ? "steer" : "promote", id)) {
      void client.invalidateQueries({ queryKey: SESSIONS_QUERY_KEY, exact: true });
      void client.invalidateQueries({ queryKey: NODES_QUERY_KEY, exact: true });
      void client.invalidateQueries({ queryKey: TASKS_QUERY_KEY, exact: true });
    }
  }, [change, running, client]);
  return { messages: state.messages, enqueue, steer, edit, remove,
    removedAt: state.removed?.removedAt, undoRemove,
    pending, paused: state.paused, sending: state.sending, waiting: awaitsPerson && !running,
    error: error ? t(error) : state.error ? t("queue.errors.dispatch") : query.isError ? t("queue.errors.unavailable") : null,
    resume: () => { void change("resume"); } };
}

/** Keep transport text out of the UI; translate stable failure categories at render time. */
function queueErrorKey(cause: unknown): string {
  const error = cause as { code?: string; status?: number } | null;
  const codes: Record<string, string> = {
    queue_full: "full", queue_sending: "sending", queue_changed: "changed", queue_thread_closed: "closed",
  };
  if (error?.code && codes[error.code]) return `queue.errors.${codes[error.code]}`;
  if (error?.status === 401) return "queue.errors.sign_in";
  if (error?.status === 403) return "queue.errors.forbidden";
  if (error?.status === 404) return "queue.errors.closed";
  return "queue.errors.change_failed";
}
