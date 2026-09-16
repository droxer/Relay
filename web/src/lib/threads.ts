import type { AgentName, ProjectRecord, RelaySession, RelayTaskSummary } from "../types.js";

// A thread is one owner-scoped session. The row binds to the session
// itself (not an employee), so the logged-in employee can hold several in
// parallel and switch between them.
export type ThreadItem = {
  session: RelaySession;
  /** Agent of an in-flight run for this thread, if any. */
  runningAgent?: AgentName;
  /** The computer this thread is pinned to is unreachable. */
  nodeOffline?: boolean;
  /** The backlog task or routine that started this thread; absent for a chat. */
  origin?: ThreadOrigin;
};

/** Where a task-driven thread came from. Project membership is not an origin:
 *  project threads live under their project folder, so the rail says so by
 *  placement rather than with a mark. */
export type ThreadOrigin = {
  kind: "backlog" | "routine";
  taskId: string;
  /** The backlog task's title, or the parent routine's for an occurrence. */
  title: string;
};

type OriginTask = Pick<
  RelayTaskSummary,
  "id" | "title" | "isRoutine" | "sourceRoutineId" | "linkedSessionIds" | "deletedAt"
>;

/**
 * Session id → origin, inverted from the task list. Only a task records which
 * sessions it ran (`linkedSessionIds`); a session carries no task id, so the
 * rail builds this once per task-list change instead of scanning per row.
 */
export function threadOriginIndex(tasks: readonly OriginTask[]): Map<string, ThreadOrigin> {
  const live = tasks.filter((task) => !task.deletedAt);
  const titles = new Map(live.map((task) => [task.id, task.title]));
  const index = new Map<string, ThreadOrigin>();
  for (const task of live) {
    const isRoutine = task.isRoutine || Boolean(task.sourceRoutineId);
    const origin: ThreadOrigin = {
      kind: isRoutine ? "routine" : "backlog",
      taskId: task.id,
      title: (task.sourceRoutineId && titles.get(task.sourceRoutineId)) || task.title,
    };
    for (const sessionId of task.linkedSessionIds) {
      if (!index.has(sessionId)) index.set(sessionId, origin);
    }
  }
  return index;
}

export type ProjectThreadBucket = {
  project: ProjectRecord;
  threads: ThreadItem[];
};

export type ThreadDirectoryMode = "threads" | "projects";

/** Keeps independent conversations and project rooms in separate top-level navigation destinations. */
export function threadsForDirectory(
  threads: readonly ThreadItem[],
  projects: readonly ProjectRecord[],
  mode: ThreadDirectoryMode,
): ThreadItem[] {
  const projectIds = new Set(projects.map((project) => project.id));
  return threads.filter((thread) => {
    const projectId = thread.session.projectId;
    return mode === "projects" ? Boolean(projectId && projectIds.has(projectId)) : !projectId || !projectIds.has(projectId);
  });
}

/** Builds the sidebar's Project -> thread hierarchy without hiding empty projects. */
export function projectThreadBuckets(
  threads: readonly ThreadItem[],
  projects: readonly ProjectRecord[],
): { projects: ProjectThreadBucket[]; unclassified: ThreadItem[] } {
  const orderedProjects = projects
    .slice()
    .sort((a, b) => Number(Boolean(a.archivedAt)) - Number(Boolean(b.archivedAt))
      || a.name.localeCompare(b.name));
  const byProject = new Map(orderedProjects.map((project) => [project.id, [] as ThreadItem[]]));
  const unclassified: ThreadItem[] = [];
  for (const thread of threads) {
    const bucket = thread.session.projectId ? byProject.get(thread.session.projectId) : undefined;
    if (bucket) bucket.push(thread);
    else unclassified.push(thread);
  }
  return {
    projects: orderedProjects.map((project) => ({ project, threads: byProject.get(project.id) ?? [] })),
    unclassified,
  };
}

/** Deletion is safe only after both the session snapshot and daemon report no active run. */
export function canDeleteThread(item: ThreadItem): boolean {
  return item.session.status !== "running" && !item.runningAgent;
}

type Labelled = { title?: string; taskGoal: string };

// The logged-in employee's own threads, newest first. /api/v1/threads is already
// owner-scoped by the backend, but we defensively filter by owner (and drop
// archived/closed ones) so the list never surfaces another employee's work.
export function myThreadSessions(
  sessions: readonly RelaySession[],
  employeeId: string,
): RelaySession[] {
  return sessions
    .filter((s) => !s.archived && (!s.ownerEmployeeId || s.ownerEmployeeId === employeeId))
    .slice()
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

// Merge a session returned by a mutation into the cached list, replacing any
// record with the same id. Creating a thread resolves with the new
// session long before the list refetch lands, so the caller seeds it here to
// keep the selection resolvable — otherwise pickActiveThreadSession
// cannot find the selected id and falls back to the most recent thread.
export function upsertThreadSession(
  sessions: readonly RelaySession[],
  session: RelaySession,
): RelaySession[] {
  const others = sessions.filter((candidate) => candidate.id !== session.id);
  return [session, ...others].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function pickActiveThreadSession(input: {
  threads: readonly RelaySession[];
  selectedSessionId?: string;
  activeSessionId: string | null;
  composingNew: boolean;
}): RelaySession | undefined {
  if (input.composingNew) return undefined;
  if (input.selectedSessionId) {
    const selected = input.threads.find((session) => session.id === input.selectedSessionId);
    if (selected) return selected;
  }
  if (input.activeSessionId) {
    const active = input.threads.find((session) => session.id === input.activeSessionId);
    if (active) return active;
  }
  return input.threads[0];
}

// The human-facing label for a thread: the editable title when set,
// otherwise the originating task goal.
export function threadLabel(session: Labelled): string {
  return session.title?.trim() || session.taskGoal;
}

// The distinct agents that have worked a thread — every agent that has a
// run, plus the current one — in first-appearance order so the row's mark
// cluster is deterministic per session and reflects who touched it, in order.
export function sessionAgents(
  session: Pick<RelaySession, "agentRuns" | "currentAgent">,
): AgentName[] {
  const seen = new Set<AgentName>();
  const order: AgentName[] = [];
  const add = (agent: AgentName | undefined) => {
    if (agent && !seen.has(agent)) {
      seen.add(agent);
      order.push(agent);
    }
  };
  for (const run of session.agentRuns ?? []) add(run.agent);
  add(session.currentAgent);
  return order;
}

// Title/goal substring search used by the thread list filter.
export function matchesThreadQuery(session: Labelled, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (session.title?.toLowerCase() ?? "").includes(q) || session.taskGoal.toLowerCase().includes(q);
}

/** How a thread row spends its vertical space.
 *
 *  The second line exists to carry status. A settled thread deliberately says
 *  nothing about status — the group header above it already reads "idle", and
 *  restating that on every row is noise — which left the line holding only the
 *  agent cluster, and that cluster is decorative: the running agent is named in
 *  the status text, and the full set reads from the row's tooltip. So a settled
 *  row was paying a whole line for one ornamental glyph, on the majority of
 *  rows in any long list. The marks ride the title line there instead, beside
 *  the offline badge that already sits on it, and the row collapses to one
 *  line. Height then tracks how much a row actually has to say: attention costs
 *  more of the rail than rest does, which is the signal the rail is built on.
 *
 *  Nested rows are single-line by construction and opt out of both — they carry
 *  their own state pip because the flat in-project list has no group headers,
 *  and marks would undo the density that layout exists for. */
export function threadRowMeta(
  { layout, hasStatus, hasOrigin, agentCount }: {
    layout: "full" | "nested";
    hasStatus: boolean;
    /** A backlog / routine thread names its source on the meta line. */
    hasOrigin: boolean;
    agentCount: number;
  },
): { subline: boolean; inlineAgents: boolean } {
  if (layout !== "full") return { subline: false, inlineAgents: false };
  // The origin's name needs the meta line's width more than the decorative
  // agent marks do, so they ride the title line whenever an origin shows.
  if (hasOrigin) return { subline: true, inlineAgents: agentCount > 0 };
  if (hasStatus) return { subline: true, inlineAgents: false };
  return { subline: false, inlineAgents: agentCount > 0 };
}
