/** All the filter reads of a thread item. */
type ProjectScoped = { session: { projectId?: string | null } };

/**
 * The thread rail's project quick filter. `all` is the ordinary rail; `none`
 * keeps the threads that belong to no project; a `project:<id>` value narrows
 * to one project.
 *
 * Choosing a project shows every thread of that project — its room threads
 * included. The unfiltered rail includes all projects as well. The value is
 * prefixed so a project id cannot be mistaken for either fixed choice.
 */
export type ThreadProjectFilter = "all" | "none" | `project:${string}`;

export const THREAD_PROJECT_FILTER_ALL: ThreadProjectFilter = "all";
export const THREAD_PROJECT_FILTER_NONE: ThreadProjectFilter = "none";

export interface ThreadProjectOption {
  value: ThreadProjectFilter;
  projectId: string;
  name: string;
  archived: boolean;
}

export function threadProjectFilterFor(projectId: string): ThreadProjectFilter {
  return `project:${projectId}`;
}

function filteredProjectId(filter: ThreadProjectFilter): string | null {
  return filter.startsWith("project:") ? filter.slice("project:".length) : null;
}

/** The projects the filter offers: every live project, plus an archived one
 *  only while it still holds a thread — an archived project with nothing to
 *  show is a dead choice. Live projects first, then by name. */
export function threadProjectOptions(
  projects: readonly { id: string; name: string; archivedAt?: string | null }[],
  threads: readonly ProjectScoped[],
): ThreadProjectOption[] {
  const withThreads = new Set(threads.map((item) => item.session.projectId).filter(Boolean));
  return projects
    .filter((project) => !project.archivedAt || withThreads.has(project.id))
    .map((project) => ({
      value: threadProjectFilterFor(project.id),
      projectId: project.id,
      name: project.name,
      archived: Boolean(project.archivedAt),
    }))
    .sort((a, b) => Number(a.archived) - Number(b.archived) || a.name.localeCompare(b.name));
}

/** A remembered project that has since been deleted (or archived empty) falls
 *  back to every thread rather than an unexplained empty rail. */
export function resolveThreadProjectFilter(
  filter: ThreadProjectFilter,
  options: readonly ThreadProjectOption[],
): ThreadProjectFilter {
  const projectId = filteredProjectId(filter);
  if (projectId === null) return filter;
  return options.some((option) => option.projectId === projectId) ? filter : THREAD_PROJECT_FILTER_ALL;
}

/**
 * Applies the filter on top of the search query.
 * - `railThreads`: the ordinary threads rail (all query-matched threads).
 * - `matchedThreads`: every query-matched thread, room threads included.
 */
export function applyThreadProjectFilter<T extends ProjectScoped>(
  filter: ThreadProjectFilter,
  railThreads: readonly T[],
  matchedThreads: readonly T[],
): T[] {
  if (filter === THREAD_PROJECT_FILTER_ALL) return [...railThreads];
  if (filter === THREAD_PROJECT_FILTER_NONE) return railThreads.filter((item) => !item.session.projectId);
  const projectId = filteredProjectId(filter);
  return matchedThreads.filter((item) => item.session.projectId === projectId);
}
