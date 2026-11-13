/** A persisted text follow-up awaiting the thread's next round. */
export type QueueAddress = { addressAgentIds?: string[]; addressTeamId?: string };
export type QueuedMessage = { id: string; text: string } & QueueAddress;
/** Mirrored by the backend queue's admission limit. */
export const MAX_QUEUED_MESSAGES = 20;
