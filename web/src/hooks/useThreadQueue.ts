import { useCallback, useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import type { ComposerHandle } from "../components/composer/Composer";
import { shouldDrainQueue, type QueueDrainMode, type QueuedMessage } from "../lib/threadQueue";
import { EMPTY_QUEUE, useThreadQueueStore } from "../lib/threadQueueStore";

/**
 * A thread's message queue: what the person writes while a run is going, sent
 * one at a time once the thread can take another round.
 *
 * Nothing here reaches the run itself — the backend takes one round at a time
 * and no runtime accepts input mid-run — so steering is "stop, then send this
 * first": the picked message moves to the head and the live run is stopped;
 * when it settles, the head goes. Every send goes through the composer's own
 * path, so a queued `@mention` still addresses the agent it names.
 */
export function useThreadQueue({ queueKey, running, awaitsPerson, composerRef, onCancelRun }: {
  queueKey: string;
  running: boolean;
  /** A question, decision, or permission prompt is waiting on the person. */
  awaitsPerson: boolean;
  composerRef: RefObject<ComposerHandle | null>;
  onCancelRun: () => void;
}) {
  const hydrate = useThreadQueueStore((state) => state.hydrate);
  // Before paint, so a thread's stored queue never flashes in empty.
  useLayoutEffect(() => hydrate(queueKey), [hydrate, queueKey]);
  const messages = useThreadQueueStore((state) => state.queues[queueKey] ?? EMPTY_QUEUE);

  const modeRef = useRef<QueueDrainMode>("auto");
  const inFlightRef = useRef(false);
  const previousRef = useRef({ key: queueKey, running });

  // While a queued send is in flight, the run transitions it causes itself (a
  // rejected dispatch flips `running` back) must not fire the next one. A
  // failed send goes back to the head and the queue pauses for the person.
  const sendQueued = useCallback(async (message: QueuedMessage): Promise<boolean> => {
    if (inFlightRef.current) return false;
    const store = useThreadQueueStore.getState();
    inFlightRef.current = true;
    store.remove(queueKey, message.id);
    try {
      const sent = await (composerRef.current?.send(message.text, { asTyped: true }) ?? Promise.resolve(false));
      modeRef.current = sent ? "auto" : "paused";
      if (!sent) store.restore(queueKey, message);
      return sent;
    } finally {
      inFlightRef.current = false;
    }
  }, [composerRef, queueKey]);

  useEffect(() => {
    const previous = previousRef.current;
    previousRef.current = { key: queueKey, running };
    // Another thread: its run state is not a transition of this one.
    if (previous.key !== queueKey) {
      modeRef.current = "auto";
      return;
    }
    if (inFlightRef.current) return;
    // The person started a round themselves after a Stop: they are driving
    // again, so the queue follows the next run's end as usual.
    if (!previous.running && running && modeRef.current === "paused") modeRef.current = "auto";
    const head = messages[0];
    if (!head || !shouldDrainQueue({
      wasRunning: previous.running,
      running,
      mode: modeRef.current,
      awaitsPerson,
      queued: messages.length,
    })) return;
    void sendQueued(head);
  }, [queueKey, running, awaitsPerson, messages, sendQueued]);

  const enqueue = useCallback((text: string) => {
    useThreadQueueStore.getState().enqueue(queueKey, text);
  }, [queueKey]);

  const steer = useCallback((id: string) => {
    const message = messages.find((item) => item.id === id);
    if (!message) return;
    if (!running) {
      void sendQueued(message);
      return;
    }
    useThreadQueueStore.getState().promote(queueKey, id);
    modeRef.current = "steer";
    onCancelRun();
  }, [messages, running, sendQueued, queueKey, onCancelRun]);

  /** Back into the box to rework; a draft already there keeps its place first. */
  const edit = useCallback((id: string) => {
    const message = messages.find((item) => item.id === id);
    const composer = composerRef.current;
    if (!message || !composer) return;
    useThreadQueueStore.getState().remove(queueKey, id);
    const draft = composer.getText().trim();
    composer.setText(draft ? `${draft}\n\n${message.text}` : message.text);
    composer.focus();
  }, [messages, composerRef, queueKey]);

  const remove = useCallback((id: string) => {
    useThreadQueueStore.getState().remove(queueKey, id);
  }, [queueKey]);

  /** The person's own Stop: what they queued waits for them to choose. */
  const stop = useCallback(() => {
    modeRef.current = "paused";
    onCancelRun();
  }, [onCancelRun]);

  return { messages, enqueue, steer, edit, remove, stop };
}
