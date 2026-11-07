/** A message written while the thread's run was still going, held until the
 *  thread can take another round. */
export type QueuedMessage = { id: string; text: string };

/** How the queue reacts when the live run ends. `auto` sends the head;
 *  `paused` holds everything (the person pressed Stop, or a queued send
 *  failed); `steer` sends the head even past a Stop — the person picked it to
 *  replace the run they just stopped. */
export type QueueDrainMode = "auto" | "paused" | "steer";

/** Enough to keep a train of thought; a longer queue is a backlog, not steering. */
export const MAX_QUEUED_MESSAGES = 20;

export function enqueueMessage(queue: readonly QueuedMessage[], text: string, id: string): QueuedMessage[] {
  const trimmed = text.trim();
  if (!trimmed || queue.length >= MAX_QUEUED_MESSAGES) return [...queue];
  return [...queue, { id, text: trimmed }];
}

export function removeQueuedMessage(queue: readonly QueuedMessage[], id: string): QueuedMessage[] {
  return queue.filter((message) => message.id !== id);
}

/** Moves the picked message to the head, so it is the next one sent. */
export function promoteQueuedMessage(queue: readonly QueuedMessage[], id: string): QueuedMessage[] {
  const picked = queue.find((message) => message.id === id);
  if (!picked) return [...queue];
  return [picked, ...queue.filter((message) => message.id !== id)];
}

/** Whether a run that just ended should hand the queue's head to the thread.
 *  Only a transition counts — opening a thread with a leftover queue never
 *  sends on its own. A question, decision, or permission prompt waiting on the
 *  person pauses the queue: what they wrote mid-run may no longer fit, so they
 *  choose. A steer is that choice already made. */
export function shouldDrainQueue(input: {
  wasRunning: boolean;
  running: boolean;
  mode: QueueDrainMode;
  awaitsPerson: boolean;
  queued: number;
}): boolean {
  if (!input.wasRunning || input.running || input.queued === 0) return false;
  if (input.mode === "steer") return true;
  return input.mode === "auto" && !input.awaitsPerson;
}
