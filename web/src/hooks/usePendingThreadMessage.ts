import { useSyncExternalStore } from "react";
import type { AgentRunInput, ThreadMessageInput } from "../types";
import type { QueuedMessage } from "../lib/threadQueue";

type MessagePreview = { id: string; text: string };

export type PendingDirectMessage = MessagePreview & (
  | { kind: "append"; sessionId: string; input: ThreadMessageInput }
  | { kind: "create"; input: AgentRunInput }
);

export type PendingQueueMessage = QueuedMessage & { kind: "enqueue" };

export type ThreadMessageRetry = {
  text: string;
  busy: boolean;
  attachmentIds?: string[];
  retry: () => Promise<boolean>;
  dismiss: () => void;
};

const listeners = new Set<() => void>();
// Keep recovery available in the current page if the browser refuses storage.
const volatile = new Map<string, string | null>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function snapshot(key: string) {
  if (volatile.has(key)) return volatile.get(key) ?? null;
  try { return sessionStorage.getItem(key); }
  catch { return null; }
}

function write(key: string, value: string | null) {
  try {
    if (value === null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, value);
    volatile.delete(key);
  } catch {
    volatile.set(key, value);
  }
  for (const listener of listeners) listener();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function parse(raw: string | null): PendingDirectMessage | PendingQueueMessage | null {
  try {
    const message: unknown = raw ? JSON.parse(raw) : null;
    if (!isRecord(message) || typeof message.id !== "string" || !message.id || typeof message.text !== "string") return null;
    if (message.kind === "enqueue") {
      const { addressAgentIds, addressTeamId } = message;
      if (addressAgentIds !== undefined && (!Array.isArray(addressAgentIds) || !addressAgentIds.every(id => typeof id === "string"))) return null;
      if (addressTeamId !== undefined && typeof addressTeamId !== "string") return null;
      return { kind: "enqueue", id: message.id, text: message.text, addressAgentIds, addressTeamId };
    }
    const { input } = message;
    if (!isRecord(input) || input.userMessageId !== message.id || input.idempotencyKey !== message.id) return null;
    // The API validates the stored request body again on replay. Check the
    // fields this UI reads before offering recovery.
    if (input.attachmentIds !== undefined &&
      (!Array.isArray(input.attachmentIds) || !input.attachmentIds.every(id => typeof id === "string"))) return null;
    if (message.kind === "create" && typeof input.taskGoal === "string") return message as PendingDirectMessage;
    if (message.kind === "append" && typeof message.sessionId === "string" && typeof input.text === "string") return message as PendingDirectMessage;
  } catch { /* Ignore a malformed record. */ }
  return null;
}

function storageKey(scope: string, channel: "direct" | "queue"): string {
  return `relay-web.pending-message:${channel}:${scope}`;
}

export function clearPendingThreadMessage(scope: string, channel: "direct" | "queue", id: string) {
  const key = storageKey(scope, channel);
  if (parse(snapshot(key))?.id === id) write(key, null);
}

export function usePendingThreadMessage(scope: string, channel: "direct" | "queue") {
  const key = storageKey(scope, channel);
  const raw = useSyncExternalStore(subscribe, () => snapshot(key), () => null);
  return {
    message: parse(raw),
    read: () => parse(snapshot(key)),
    save: (message: PendingDirectMessage | PendingQueueMessage) => write(key, JSON.stringify(message)),
    clear: (id: string) => clearPendingThreadMessage(scope, channel, id),
  };
}
