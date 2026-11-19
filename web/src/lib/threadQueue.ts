/** A persisted text follow-up awaiting the thread's next round. */
export type QueueAddress = { addressAgentIds?: string[]; addressTeamId?: string };
export type QueuedMessage = { id: string; text: string } & QueueAddress;
export const THREAD_QUEUE_QUERY_KEY = ["thread-queue"] as const;
/** Mirrored by the backend queue's admission limit. */
export const MAX_QUEUED_MESSAGES = 20;
