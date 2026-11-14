/** All the kind filter reads of a thread item. */
type KindScoped = { origin?: unknown };

/**
 * The thread rail's kind quick filter. A thread is task work when a backlog
 * task or automation occurrence ran it (`origin`), and a chat otherwise.
 */
export type ThreadKindFilter = "all" | "tasks" | "chats";

export const THREAD_KIND_FILTER_ALL: ThreadKindFilter = "all";

export const THREAD_KIND_FILTERS: readonly ThreadKindFilter[] = ["all", "tasks", "chats"];

export function applyThreadKindFilter<T extends KindScoped>(filter: ThreadKindFilter, threads: readonly T[]): T[] {
  if (filter === THREAD_KIND_FILTER_ALL) return [...threads];
  return threads.filter((item) => Boolean(item.origin) === (filter === "tasks"));
}
