import type { RelaySession } from "../types.ts";
import { THREAD_PAGE_SIZE } from "./sessionPollMerge.ts";

/**
 * The first-page threads whose transcript is not cached yet, in list order,
 * as one string key (ids joined by newlines; empty when there are none).
 * A summary carries no events, so a thread with none has never been fetched
 * in full; preloading it lets the transcript render the moment it is opened,
 * while the open thread's own fetch and stream reconcile it.
 */
export function threadPreloadKey(sessions: readonly RelaySession[], limit = THREAD_PAGE_SIZE): string {
  return sessions
    .slice(0, limit)
    .filter((session) => session.events.length === 0)
    .map((session) => session.id)
    .join("\n");
}
