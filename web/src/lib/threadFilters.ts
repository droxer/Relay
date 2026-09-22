/**
 * The thread rail's quick filters, as one value.
 *
 * They live with the rail's owner rather than inside the panel, the same way
 * the search query does: the panel unmounts whenever a task thread takes the
 * pane, and a filter that survives that remount while the search box beside
 * it does not (or the reverse) is an inconsistency the reader feels as the
 * list silently re-widening.
 */

/** The attention partition `groupThreads` announces, plus "no filter". */
export type AttentionFilter = "all" | "needsYou" | "running" | "idle";

export type ThreadFilters = {
  attention: AttentionFilter;
  /** A project id, or "all" — never a project the rail cannot currently show. */
  projectId: string;
};

export const THREAD_FILTERS_NONE: ThreadFilters = { attention: "all", projectId: "all" };

/** Whether anything is narrowing the list — the empty state answers differently. */
export function threadFiltersActive(filters: ThreadFilters): boolean {
  return filters.attention !== "all" || filters.projectId !== "all";
}

/** A new value; filters are replaced, never mutated in place. */
export function withThreadFilter(filters: ThreadFilters, patch: Partial<ThreadFilters>): ThreadFilters {
  return { ...filters, ...patch };
}

/**
 * A filter naming a project that has fallen out of the list (deleted, or a
 * failed refetch) reads as "all" rather than hiding every row.
 */
export function resolveProjectFilter(projectId: string, projectIds: readonly string[]): string {
  return projectIds.includes(projectId) ? projectId : "all";
}
