import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ComposerHandle } from "../components/composer/Composer";
import { restoreComposerDraft } from "./useComposer";
import { cancelRun } from "../api-client/sessions";
import { apiJson } from "../api-client/client";
import type { QueuedMessage, QueueAddress } from "../lib/threadQueue";

type QueueState = { messages: QueuedMessage[]; paused: boolean; sending?: string; error?: string };
const EMPTY: QueueState = { messages: [], paused: false };

/** The server owns ordering and dispatch; no open browser is required. */
export function useThreadQueue({ queueKey, threadId, running, awaitsPerson, composerRef, onCancelRun }: {
  queueKey: string;
  threadId?: string;
  running: boolean;
  awaitsPerson: boolean;
  composerRef: RefObject<ComposerHandle | null>;
  onCancelRun: () => void;
}) {
  const client = useQueryClient();
  const [errorState, setErrorState] = useState<{ key: string; message: string | null } | null>(null);
  const error = errorState?.key === queueKey ? errorState.message : null;
  const setError = useCallback((message: string | null) => setErrorState({ key: queueKey, message }), [queueKey]);
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  const unsaved = useRef(new Map<string, QueuedMessage>());
  const key = ["thread-queue", queueKey];
  const path = `/threads/${encodeURIComponent(threadId ?? "")}/queue`;
  const query = useQuery({ queryKey: key, queryFn: () => apiJson<QueueState>(path), enabled: !!threadId,
    refetchInterval: 1000, refetchOnWindowFocus: "always" });
  const state = query.data?.messages ? query.data : EMPTY;
  const activeKey = useRef(queueKey);
  useLayoutEffect(() => { activeKey.current = queueKey; }, [queueKey]);
  const change = useCallback(async (action: string, id?: string, text?: string, address?: QueueAddress) => {
    if (!threadId || busy.current) return false;
    busy.current = true;
    setPending(true);
    try {
      await apiJson<QueueState>(path, { method: "POST", body: { action, id, text, ...address } });
      await client.invalidateQueries({ queryKey: ["thread-queue", queueKey] });
      if (activeKey.current === queueKey) setError(null);
      return true;
    } catch (cause) {
      if (activeKey.current === queueKey) setError(cause instanceof Error ? cause.message : String(cause));
      return false;
    } finally { busy.current = false; setPending(false); }
  }, [threadId, path, queueKey, client, setError]);

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
    if (await change("promote", id)) {
      // Cancellation preserves the queue for this explicit replacement.
      if (running && threadId) {
        try { await cancelRun(threadId, undefined, "Send queued message first.", true); }
        catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
        await client.invalidateQueries();
      }
    }
  }, [change, running, threadId, client, setError]);
  const stop = useCallback(async () => {
    if (!(await change("pause"))) return;
    if (!threadId) { onCancelRun(); return; }
    try { await cancelRun(threadId); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    await client.invalidateQueries();
  }, [change, onCancelRun, threadId, client, setError]);
  return { messages: state.messages, enqueue, steer, edit, remove, stop,
    pending, paused: state.paused, sending: state.sending, waiting: awaitsPerson && !running,
    error: error ?? state.error ?? (query.isError ? "Queue unavailable. Your draft has been kept." : null),
    resume: () => { void change("resume"); } };
}
