/* Cross-route "create task" intent. The `c` chord and the command menu create
   a task from anywhere in the app: when the backlog is not mounted the intent
   must survive the navigation that mounts it, so it is a one-shot flag plus a
   DOM event, not just an event. The channel is a factory so tests can drive it
   with a bare EventTarget instead of `window`. */

export const TASK_CREATE_INTENT_EVENT = "relay:task-create-intent";

type TaskCreateIntentChannel = {
  /** Arms the one-shot flag and notifies any mounted listener. */
  queue: () => void;
  /** Reads and clears the flag. True at most once per queue(). */
  consume: () => boolean;
  /** Notifies immediately when queue() fires; returns an unsubscribe. */
  subscribe: (listener: () => void) => () => void;
};

export function createTaskCreateIntentChannel(target: EventTarget): TaskCreateIntentChannel {
  let pending = false;
  return {
    queue() {
      pending = true;
      target.dispatchEvent(new Event(TASK_CREATE_INTENT_EVENT));
    },
    consume() {
      const was = pending;
      pending = false;
      return was;
    },
    subscribe(listener) {
      target.addEventListener(TASK_CREATE_INTENT_EVENT, listener);
      return () => target.removeEventListener(TASK_CREATE_INTENT_EVENT, listener);
    },
  };
}

let shared: TaskCreateIntentChannel | null = null;

/** The app-wide channel, bound to window. Null on the server. */
export function taskCreateIntent(): TaskCreateIntentChannel | null {
  if (typeof window === "undefined") return null;
  shared ??= createTaskCreateIntentChannel(window);
  return shared;
}
