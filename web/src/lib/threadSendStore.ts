import { create } from "zustand";

export type PendingUserMessage = { id: string; text: string };

// A thread dispatch in flight. This is deliberately not derived from
// TanStack Query's mutation state: one dispatch spans several mutations (the
// send, then a cancel if Stop was pressed mid-flight), the same mutations run
// from other pages, and the echoed turn has to outlive the mutation until the
// persisted event arrives on the session.
interface ThreadSendStore {
  /** Optimistic echo of the just-sent turn, hidden once the real one lands. */
  pendingUserMessage: PendingUserMessage | null;
  /** A send or recovery dispatch has not returned yet. */
  dispatching: boolean;

  beginSend: (message: PendingUserMessage) => void;
  beginDispatch: () => void;
  endDispatch: () => void;
  dropPendingMessage: () => void;
}

export const useThreadSendStore = create<ThreadSendStore>((set, get) => ({
  pendingUserMessage: null,
  dispatching: false,

  beginSend: (pendingUserMessage) => set({ pendingUserMessage, dispatching: true }),
  beginDispatch: () => set({ dispatching: true }),
  endDispatch: () => set({ dispatching: false }),
  dropPendingMessage: () => {
    if (get().pendingUserMessage !== null) set({ pendingUserMessage: null });
  },
}));
