/**
 * Home's status panels beside the queue: the person's tasks by stage, their
 * projects at a glance, what is running now, and what finished lately. Every
 * reading is derived from data the app already loads.
 */
import type { DaemonNodeMonitorRecord, ProjectRecord, RelaySession, RelayTaskListItem } from "../types.js";
import type { HomeItem } from "./homeQueue.ts";
import { openPermissionRequests } from "./permissionRequests.ts";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
export const HOME_PROJECT_LIMIT = 6;
export const HOME_FINISHED_LIMIT = 5;

/** Each count reads a task's own status, the way the Tasks queue of the same
 *  name does, so a count and the list it links to always agree. Work flow
 *  stages are not used: they file blocked and waiting work under "running". */
export interface MyTaskCounts {
  open: number;
  running: number;
  blocked: number;
  doneThisWeek: number;
}

/** The statuses a project's progress bar draws, in the order it draws them. */
export const PROJECT_PROGRESS = ["done", "review", "running", "blocked"] as const;
export type ProjectProgress = Record<(typeof PROJECT_PROGRESS)[number], number>;

export interface HomeProjectRow {
  project: ProjectRecord;
  total: number;
  progress: ProjectProgress;
  waitingOnYou: number;
  /** The first queue item in this project — what to do there next. */
  next: HomeItem | null;
}

export interface RunningRow {
  session: RelaySession;
  /** When the run started, else when the thread last moved. */
  startedAt: string;
  agentId?: string;
  computerId?: string;
  /** The run holds for a permission prompt. */
  paused: boolean;
}

const isIssue = (task: RelayTaskListItem) => !task.isRoutine && !task.deletedAt;
const isMine = (task: RelayTaskListItem, userId: string) => (task.assigneeUserId ?? task.ownerUserId) === userId;
const finishedAt = (task: RelayTaskListItem) => task.finishedAt ?? task.updatedAt;

/** Work in an archived project leaves the Tasks page, so it leaves these
 *  counts too; otherwise a count would open a list shorter than itself. */
export function myTaskCounts(
  tasks: readonly RelayTaskListItem[],
  userId: string,
  now = Date.now(),
  archivedProjectIds: ReadonlySet<string> = new Set(),
): MyTaskCounts {
  const mine = tasks.filter((task) => isIssue(task) && isMine(task, userId)
    && !(task.projectId && archivedProjectIds.has(task.projectId)));
  const withStatus = (status: RelayTaskListItem["status"]) => mine.filter((task) => task.status === status).length;
  return {
    open: mine.filter((task) => task.status !== "done").length,
    running: withStatus("running"),
    blocked: withStatus("blocked"),
    doneThisWeek: mine.filter((task) => task.status === "done" && now - Date.parse(finishedAt(task)) <= WEEK_MS).length,
  };
}

/** Live projects, the ones with something for the person first (in queue
 *  order), then the most recently touched. */
export function homeProjects(
  projects: readonly ProjectRecord[],
  tasks: readonly RelayTaskListItem[],
  queue: readonly HomeItem[],
  limit = HOME_PROJECT_LIMIT,
): HomeProjectRow[] {
  const rows = projects
    .filter((project) => !project.archivedAt)
    .map((project): HomeProjectRow => {
      const issues = tasks.filter((task) => isIssue(task) && task.projectId === project.id);
      const items = queue.filter((item) => item.projectId === project.id);
      const progress = Object.fromEntries(
        PROJECT_PROGRESS.map((status) => [status, issues.filter((task) => task.status === status).length]),
      ) as ProjectProgress;
      return {
        project,
        total: issues.length,
        progress,
        waitingOnYou: items.filter((item) => item.tier === "paused" || item.tier === "needs_you").length,
        next: items[0] ?? null,
      };
    });
  const rank = (row: HomeProjectRow) => (row.next ? queue.indexOf(row.next) : Number.POSITIVE_INFINITY);
  const touched = (row: HomeProjectRow) => latest(row.project.updatedAt, tasks, row.project.id);
  return rows
    .sort((left, right) => rank(left) - rank(right) || touched(right).localeCompare(touched(left)))
    .slice(0, limit);
}

function latest(projectUpdatedAt: string, tasks: readonly RelayTaskListItem[], projectId: string): string {
  return tasks.reduce(
    (newest, task) => (task.projectId === projectId && task.updatedAt > newest ? task.updatedAt : newest),
    projectUpdatedAt,
  );
}

/** Done work only: a task in review still wants the person, so it stays in
 *  the queue rather than reading as finished twice. */
export function recentlyFinished(
  tasks: readonly RelayTaskListItem[],
  userId: string,
  limit = HOME_FINISHED_LIMIT,
): RelayTaskListItem[] {
  return tasks
    .filter((task) => isIssue(task) && isMine(task, userId) && task.status === "done")
    .sort((left, right) => finishedAt(right).localeCompare(finishedAt(left)))
    .slice(0, limit);
}

export function runningNow(
  sessions: readonly RelaySession[],
  nodes: readonly DaemonNodeMonitorRecord[],
  userId: string,
): RunningRow[] {
  const runs = new Map(
    nodes.flatMap((node) => (node.activeRuns ?? []).map((run) => [run.sessionId, { run, computerId: node.id }] as const)),
  );
  return sessions
    .filter((session) => (!session.ownerUserId || session.ownerUserId === userId) && isRunning(session, runs.has(session.id)))
    .map((session): RunningRow => {
      const active = runs.get(session.id);
      return {
        session,
        startedAt: active?.run.startedAt ?? session.updatedAt,
        ...(active?.run.logicalAgentId ? { agentId: active.run.logicalAgentId } : {}),
        ...(active ? { computerId: active.computerId } : {}),
        paused: openPermissionRequests(session).length > 0,
      };
    })
    .sort((left, right) => left.startedAt.localeCompare(right.startedAt));
}

/** The thread rail's rule (`groupThreads`): the backend-derived execution
 *  phase decides, and a session without one runs only while a computer
 *  reports its run. A bare `status: "running"` is not enough — a thread from
 *  before execution tracking keeps that status forever after its run ended. */
function isRunning(session: RelaySession, hasActiveRun: boolean): boolean {
  if (session.archived || session.deletionRequestedAt) return false;
  if (session.execution) return session.execution.phase !== "terminal";
  return hasActiveRun;
}
