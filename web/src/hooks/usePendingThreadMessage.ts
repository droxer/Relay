import { useSyncExternalStore } from "react";
import type { AgentRunInput, ThreadMessageInput } from "../types";
import type { QueuedMessage } from "../lib/threadQueue";
import { messageDefinitelyRejected, messageDeliveryUncertain } from "../api-client/client";

type MessagePreview = { id: string; text: string; deliveryUnconfirmed?: boolean };

export type PendingDirectMessage = MessagePreview & (
  | { kind: "append"; sessionId: string; input: ThreadMessageInput }
  | { kind: "create"; input: AgentRunInput }
);

export type PendingQueueMessage = QueuedMessage & MessagePreview & { kind: "enqueue" };

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
// Hide the retry slip during an initial in-flight send so normal sends do not flash it.
const initialSendIds = new Set<string>();

function notify() {
  for (const listener of listeners) listener();
}

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
  notify();
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
      return {
        kind: "enqueue", id: message.id, text: message.text, addressAgentIds, addressTeamId,
        deliveryUnconfirmed: message.deliveryUnconfirmed === false ? false : undefined,
      };
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

function viewSnapshot(key: string): string | null {
  const raw = snapshot(key);
  if (raw === null) return null;
  const parsed = parse(raw);
  return parsed && initialSendIds.has(parsed.id) ? `1:${raw}` : `0:${raw}`;
}

export function clearPendingThreadMessage(scope: string, channel: "direct" | "queue", id: string) {
  const hadInitial = initialSendIds.delete(id);
  const key = storageKey(scope, channel);
  if (parse(snapshot(key))?.id === id) write(key, null);
  else if (hadInitial) notify();
}

export function finishInitialThreadMessage(id: string) {
  if (initialSendIds.delete(id)) notify();
}

export function usePendingThreadMessage(scope: string, channel: "direct" | "queue") {
  const key = storageKey(scope, channel);
  const view = useSyncExternalStore(subscribe, () => viewSnapshot(key), () => null);
  const raw = view ? view.slice(2) : null;
  return {
    message: parse(raw),
    initial: view?.startsWith("1:") ?? false,
    read: () => parse(snapshot(key)),
    save: (message: PendingDirectMessage | PendingQueueMessage, initial = false) => {
      if (initial) initialSendIds.add(message.id);
      else initialSendIds.delete(message.id);
      // A reload during any request has to assume that request may commit.
      write(key, JSON.stringify({ ...message, deliveryUnconfirmed: undefined }));
    },
    reject: (message: MessagePreview, error: unknown, initial: boolean) => {
      const current = parse(snapshot(key));
      if (current?.id !== message.id) return false;
      const uncertain = (!initial && message.deliveryUnconfirmed !== false) || messageDeliveryUncertain(error);
      if (!uncertain && messageDefinitelyRejected(error)) {
        clearPendingThreadMessage(scope, channel, message.id);
        return true;
      }
      write(key, JSON.stringify({ ...current, deliveryUnconfirmed: uncertain }));
      return false;
    },
    finishInitial: (id: string) => finishInitialThreadMessage(id),
    clear: (id: string) => clearPendingThreadMessage(scope, channel, id),
  };
}
