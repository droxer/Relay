import type { QueryClient } from "@tanstack/react-query";
import type { RelaySession } from "../types";

/** A persisted text follow-up awaiting the thread's next round. */
export type QueueAddress = { addressAgentIds?: string[]; addressTeamId?: string };
export type QueuedMessage = { id: string; text: string } & QueueAddress;
export const THREAD_QUEUE_QUERY_KEY = ["thread-queue"] as const;
/** Mirrored by the backend queue's admission limit. */
export const MAX_QUEUED_MESSAGES = 20;

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
  client.setQueryData<QueueState>([...THREAD_QUEUE_QUERY_KEY, threadId], current => newestQueue(current, state));
}
