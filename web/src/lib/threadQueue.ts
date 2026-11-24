import type { QueryClient } from "@tanstack/react-query";
import type { RelaySession } from "../types.js";

/** A persisted text follow-up awaiting the thread's next round. */
export type QueueAddress = { addressAgentIds?: string[]; addressTeamId?: string };
export type QueuedMessage = { id: string; text: string } & QueueAddress;
export type QueueRecipient = {
  name: string;
  profileImageUrl?: string | null;
  kind: "agent" | "team";
};
export const THREAD_QUEUE_QUERY_KEY = ["thread-queue"] as const;
/** Mirrored by the backend queue's admission limit. */
export const MAX_QUEUED_MESSAGES = 20;

const MENTION_PREFIX = "@";

type ThreadMessageQueue = NonNullable<RelaySession["messageQueue"]>;
export type QueueState = ThreadMessageQueue & {
  removed?: NonNullable<ThreadMessageQueue["removed"]> & { removedAt?: string };
  live?: { id: string; until: string };
  eventCount?: number;
};

export const EMPTY_THREAD_QUEUE: QueueState = { messages: [], paused: false };

export function newestQueue(previous: QueueState | undefined, next: QueueState): QueueState {
  return previous?.eventCount !== undefined && next.eventCount !== undefined
    && previous.eventCount > next.eventCount ? previous : next;
}

export function cacheThreadQueue(client: QueryClient, threadId: string, state: QueueState) {
  client.setQueryData<QueueState>([...THREAD_QUEUE_QUERY_KEY, threadId], (current: QueueState | undefined) => newestQueue(current, state));
}

/**
 * Strip the leading `@Name` address run when the queue row's recipient pills
 * already express every named recipient.
 *
 * Display-only: `QueuedMessage.text` stays intact for persistence, immediate
 * send (`onSteer`), moving back to the draft (`onEdit`), and `aria-label`.
 */
export function stripLeadingQueueMentions(
  text: string,
  recipientIds: readonly string[],
  recipients: Record<string, QueueRecipient> = {},
): string {
  if (recipientIds.length === 0) return text;
  if (recipientIds.some((id) => !recipients[id] || recipients[id].kind !== "agent")) {
    return text;
  }
  const recipientIdSet = new Set(recipientIds);
  const candidates = Object.entries(recipients)
    .filter(([, recipient]) => recipient.kind === "agent" && recipient.name.trim().length > 0)
    .map(([id, recipient]) => ({ id, name: recipient.name }))
    .sort((left, right) => right.name.length - left.name.length);
  if (candidates.length === 0) return text;

  let cursor = leadingHorizontalSpace(text);
  let matchedCount = 0;
  while (text.startsWith(MENTION_PREFIX, cursor)) {
    const rest = text.slice(cursor + MENTION_PREFIX.length);
    const matched = matchRecipientName(rest, candidates, recipientIdSet);
    if (!matched) {
      if (wordLength(rest) === 0) break;
      return text;
    }
    if (!recipientIdSet.has(matched.id)) {
      return text;
    }
    matchedCount += 1;
    const end = cursor + MENTION_PREFIX.length + matched.name.length;
    cursor = end + leadingHorizontalSpace(text.slice(end));
  }
  return matchedCount > 0 ? text.slice(cursor) : text;
}

function matchRecipientName(
  rest: string,
  byLength: readonly { id: string; name: string }[],
  recipientIds: ReadonlySet<string>,
): { id: string; name: string } | null {
  const lowered = rest.toLowerCase();
  const named = byLength.filter((candidate) => {
    const name = candidate.name.toLowerCase();
    return (
      lowered === name
      || lowered.startsWith(`${name} `)
      || lowered.startsWith(`${name}\t`)
      || lowered.startsWith(`${name}\n`)
    );
  });
  if (named.length === 0) return null;
  const bestLength = named[0].name.length;
  const longest = named.filter((candidate) => candidate.name.length === bestLength);
  if (longest.length === 1) return longest[0];
  const addressed = longest.filter((candidate) => recipientIds.has(candidate.id));
  return addressed.length === 1 ? addressed[0] : null;
}

function wordLength(rest: string): number {
  const match = /^\S+/.exec(rest);
  return match ? match[0].length : 0;
}

function leadingHorizontalSpace(text: string): number {
  const match = /^[^\S\n]*/.exec(text);
  return match ? match[0].length : 0;
}
