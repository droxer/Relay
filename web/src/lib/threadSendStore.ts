import { create } from "zustand";

type PendingUserMessage = { id: string; text: string };
export type ThreadDispatch = {
  id: string;
  pendingUserMessage: PendingUserMessage | null;
  dispatching: boolean;
  stopRequested: boolean;
  openingTurn: boolean;
};

/** Drafts have their own identity until the server assigns a Thread ID. */
export function threadSendKey(user: string, sessionId: string | undefined, draftId = 0): string {
  return JSON.stringify([user, sessionId ? ["thread", sessionId] : ["draft", draftId]]);
}

interface ThreadSendStore {
  operations: Record<string, ThreadDispatch>;
  beginSend: (key: string, message: PendingUserMessage, openingTurn?: boolean) => string;
  beginDispatch: (key: string) => string;
  endDispatch: (key: string, id: string) => void;
  dropPendingMessage: (key: string, id: string) => void;
  acceptThread: (key: string, id: string, threadKey: string) => void;
  requestStop: (key: string) => void;
}

export const useThreadSendStore = create<ThreadSendStore>((set, get) => {
  const begin = (key: string, pendingUserMessage: PendingUserMessage | null, openingTurn = false) => {
    const id = crypto.randomUUID();
    set((s) => ({ operations: { ...s.operations, [key]: { id, pendingUserMessage, dispatching: true, stopRequested: false, openingTurn } } }));
    return id;
  };
  const update = (key: string, id: string, patch: Partial<ThreadDispatch>) => {
    const operation = get().operations[key];
    if (!operation || operation.id !== id) return;
    const next = { ...operation, ...patch };
    const operations = { ...get().operations };
    if (!next.dispatching && !next.pendingUserMessage) delete operations[key];
    else operations[key] = next;
    set({ operations });
  };
  return {
    operations: {},
    beginSend: (key, message, openingTurn) => begin(key, message, openingTurn),
    beginDispatch: (key) => begin(key, null),
    endDispatch: (key, id) => update(key, id, { dispatching: false }),
    dropPendingMessage: (key, id) => update(key, id, { pendingUserMessage: null }),
    requestStop: (key) => {
      const operation = get().operations[key];
      if (operation?.dispatching) update(key, operation.id, { stopRequested: true });
    },
    acceptThread: (key, id, threadKey) => {
      const operation = get().operations[key];
      if (!operation || operation.id !== id || key === threadKey) return;
      const operations = { ...get().operations };
      delete operations[key];
      // A newer operation must never be replaced by an older response.
      if (!operations[threadKey]) operations[threadKey] = operation;
      set({ operations });
    },
  };
});
