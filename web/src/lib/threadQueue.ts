/** A persisted text follow-up awaiting the thread's next round. */
export type QueuedMessage = { id: string; text: string };
/** Mirrored by the backend queue's admission limit. */
export const MAX_QUEUED_MESSAGES = 20;
