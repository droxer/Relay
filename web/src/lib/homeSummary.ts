/**
 * Home's status panels beside the queue: the person's tasks by stage, their
 * projects at a glance, what is running now, and what finished lately. Every
 * reading is derived from data the app already loads.
 */
import type { DaemonNodeMonitorRecord, ProjectRecord, RelaySession, RelayTaskListItem } from "../types.js";
import type { HomeItem } from "./homeQueue.ts";
import { openPermissionRequests } from "./permissionRequests.ts";
import { TASK_FLOW_STAGES, taskWorkflowStage, type TaskWorkflowStage } from "./taskFlow.ts";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
export const HOME_PROJECT_LIMIT = 6;
export const HOME_FINISHED_LIMIT = 5;

export interface MyTaskCounts {
  backlog: number;
  assigned: number;
  running: number;
  review: number;
  doneThisWeek: number;
}

export interface HomeProjectRow {
  project: ProjectRecord;
  total: number;
  stages: Record<TaskWorkflowStage, number>;
  blocked: number;
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

export function myTaskCounts(tasks: readonly RelayTaskListItem[], userId: string, now = Date.now()): MyTaskCounts {
  const counts: MyTaskCounts = { backlog: 0, assigned: 0, running: 0, review: 0, doneThisWeek: 0 };
  for (const task of tasks) {
    if (!isIssue(task) || !isMine(task, userId)) continue;
    const stage = taskWorkflowStage(task);
    if (stage !== "done") {
      counts[stage] += 1;
    } else if (now - Date.parse(finishedAt(task)) <= WEEK_MS) {
      counts.doneThisWeek += 1;
    }
  }
  return counts;
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
      const stages = Object.fromEntries(TASK_FLOW_STAGES.map((stage) => [stage, 0])) as Record<TaskWorkflowStage, number>;
      for (const task of issues) stages[taskWorkflowStage(task)] += 1;
      return {
        project,
        total: issues.length,
        stages,
        blocked: issues.filter((task) => task.status === "blocked").length,
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

export function recentlyFinished(
  tasks: readonly RelayTaskListItem[],
  userId: string,
  limit = HOME_FINISHED_LIMIT,
): RelayTaskListItem[] {
  return tasks
    .filter((task) => isIssue(task) && isMine(task, userId) && (task.status === "done" || task.status === "review"))
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
    .filter((session) => session.status === "running" && !session.archived && (!session.ownerUserId || session.ownerUserId === userId))
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
