import { create } from "zustand";
import {
  enqueueMessage,
  promoteQueuedMessage,
  removeQueuedMessage,
  type QueuedMessage,
} from "./threadQueue.ts";

// Each thread's queued messages, keyed like the composer draft (per signed-in
// user and thread). Kept in sessionStorage beside the draft so a reload or a
// thread switch never loses what the person wrote mid-run; it is the person's
// unsent text, not server state, so it never leaves the browser.
interface ThreadQueueStore {
  queues: Record<string, QueuedMessage[]>;
  /** Reads a thread's stored queue the first time it is opened. */
  hydrate: (key: string) => void;
  enqueue: (key: string, text: string) => void;
  remove: (key: string, id: string) => void;
  promote: (key: string, id: string) => void;
  /** Puts a message back at the head — a queued send that failed. */
  restore: (key: string, message: QueuedMessage) => void;
}

const STORAGE_PREFIX = "relay-web.queue:";

export const EMPTY_QUEUE: readonly QueuedMessage[] = Object.freeze([]);

function readStored(key: string): QueuedMessage[] {
  if (typeof window === "undefined") return [];
  try {
    const parsed: unknown = JSON.parse(sessionStorage.getItem(STORAGE_PREFIX + key) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is QueuedMessage =>
      typeof item?.id === "string" && typeof item?.text === "string" && item.text.trim() !== "");
  } catch {
    return [];
  }
}

function writeStored(key: string, queue: readonly QueuedMessage[]): void {
  if (typeof window === "undefined") return;
  try {
    if (queue.length) sessionStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(queue));
    else sessionStorage.removeItem(STORAGE_PREFIX + key);
  } catch {
    // Storage may be disabled or full; the in-memory queue still works.
  }
}

export const useThreadQueueStore = create<ThreadQueueStore>((set, get) => {
  const update = (key: string, next: (queue: QueuedMessage[]) => QueuedMessage[]) => {
    const current = get().queues[key] ?? readStored(key);
    const queue = next(current);
    writeStored(key, queue);
    set({ queues: { ...get().queues, [key]: queue } });
  };
  return {
    queues: {},
    hydrate: (key) => {
      if (get().queues[key]) return;
      set({ queues: { ...get().queues, [key]: readStored(key) } });
    },
    enqueue: (key, text) => update(key, (queue) => enqueueMessage(queue, text, `q_${crypto.randomUUID()}`)),
    remove: (key, id) => update(key, (queue) => removeQueuedMessage(queue, id)),
    promote: (key, id) => update(key, (queue) => promoteQueuedMessage(queue, id)),
    restore: (key, message) => update(key, (queue) => [message, ...removeQueuedMessage(queue, message.id)]),
  };
});
