/**
 * The Issues page's vocabulary: which queue an issue sits in and how the
 * table bands them.
 *
 * Issues is the cross-project view. A project's own Tasks tab is where work is
 * planned and run; this page answers "what needs attention anywhere?", so its
 * navigation is queues — each a saved slice over facts every task already
 * carries — rather than a status board.
 *
 * `issueNeedsProject` mirrors `backend/relay/services/issue_triage.py`: an
 * issue outside a project is intake. It can be written and prioritised, but no
 * agent or team may take it and it never runs until triage moves it into a
 * project. Routine runs are exempt — a routine names its own crew.
 */
import { TASK_STATUSES, backlogSortColumns, type BacklogSortKey } from "./backlog.ts";
import { byDate, byText, type SortColumn } from "./listSort.ts";
import type { RelayTaskListItem, TaskStatus } from "../types.js";

export const ISSUE_QUEUES = ["needs_me", "untriaged", "blocked", "running", "overdue", "open", "done"] as const;
export type IssueQueue = (typeof ISSUE_QUEUES)[number];
export const DEFAULT_ISSUE_QUEUE: IssueQueue = "open";

export const ISSUE_GROUPINGS = ["project", "status", "assignee", "none"] as const;
export type IssueGroupBy = (typeof ISSUE_GROUPINGS)[number];
export const DEFAULT_ISSUE_GROUPING: IssueGroupBy = "project";

/** The band key for records that have no value on the grouped field. */
export const NO_GROUP = "none";

export interface IssueQueueContext {
  employeeId: string;
  today: string;
}

export interface IssueGroup {
  key: string;
  /** Empty for `NO_GROUP` and for status bands — the page words those. */
  label: string;
  tasks: RelayTaskListItem[];
}

export interface IssueGroupLabels {
  project: (projectId: string) => string;
  assignee: (task: RelayTaskListItem) => string;
}

const HUMAN_GATED: ReadonlySet<TaskStatus> = new Set(["waiting_for_human", "review"]);

export function issueNeedsProject(task: Pick<RelayTaskListItem, "projectId" | "isRoutine" | "sourceRoutineId">): boolean {
  return !(task.projectId || task.isRoutine || task.sourceRoutineId);
}

function responsibleEmployee(task: RelayTaskListItem): string | undefined {
  return task.assigneeEmployeeId ?? task.ownerEmployeeId;
}

function inQueue(task: RelayTaskListItem, queue: IssueQueue, { employeeId, today }: IssueQueueContext): boolean {
  const done = task.status === "done";
  switch (queue) {
    case "needs_me":
      return HUMAN_GATED.has(task.status) && responsibleEmployee(task) === employeeId;
    case "untriaged":
      return !done && issueNeedsProject(task);
    case "blocked":
      return task.status === "blocked";
    case "running":
      return task.status === "running";
    case "overdue":
      return !done && Boolean(task.dueDate) && (task.dueDate as string) < today;
    case "open":
      return !done;
    case "done":
      return done;
  }
}

/** Routine templates are schedules, not issues; they never appear here. */
export function issuesInQueue(tasks: RelayTaskListItem[], queue: IssueQueue, context: IssueQueueContext): RelayTaskListItem[] {
  return tasks.filter((task) => !task.isRoutine && inQueue(task, queue, context));
}

export function issueQueueCounts(tasks: RelayTaskListItem[], context: IssueQueueContext): Record<IssueQueue, number> {
  const issues = tasks.filter((task) => !task.isRoutine);
  return Object.fromEntries(
    ISSUE_QUEUES.map((queue) => [queue, issues.filter((task) => inQueue(task, queue, context)).length]),
  ) as Record<IssueQueue, number>;
}

export function parseIssueQueue(value: string | null | undefined): IssueQueue {
  return (ISSUE_QUEUES as readonly string[]).includes(value ?? "") ? value as IssueQueue : DEFAULT_ISSUE_QUEUE;
}

export function parseIssueGroupBy(value: string | null | undefined): IssueGroupBy {
  return (ISSUE_GROUPINGS as readonly string[]).includes(value ?? "") ? value as IssueGroupBy : DEFAULT_ISSUE_GROUPING;
}

function bucket(tasks: RelayTaskListItem[], keyOf: (task: RelayTaskListItem) => string): Map<string, RelayTaskListItem[]> {
  const groups = new Map<string, RelayTaskListItem[]>();
  for (const task of tasks) {
    const key = keyOf(task);
    groups.set(key, [...(groups.get(key) ?? []), task]);
  }
  return groups;
}

const byLabel = (a: IssueGroup, b: IssueGroup) => a.label.localeCompare(b.label);

/**
 * Bands `tasks` (already filtered and sorted — order within a band is kept).
 *
 * Project bands put "No project" FIRST: on a triage page the intake pile is
 * the band that asks for action. Assignee bands put "Unassigned" LAST, since
 * there it is the residue. Status bands follow the workflow, and a status with
 * nothing in it draws no band.
 */
export function groupIssues(tasks: RelayTaskListItem[], groupBy: IssueGroupBy, labels: IssueGroupLabels): IssueGroup[] {
  if (groupBy === "none") return tasks.length ? [{ key: NO_GROUP, label: "", tasks }] : [];
  if (groupBy === "status") {
    const groups = bucket(tasks, (task) => task.status);
    return TASK_STATUSES.flatMap((status) => {
      const members = groups.get(status);
      return members ? [{ key: status, label: "", tasks: members }] : [];
    });
  }
  if (groupBy === "project") {
    const groups = bucket(tasks, (task) => task.projectId || NO_GROUP);
    const none = groups.get(NO_GROUP);
    const named = [...groups.entries()]
      .filter(([key]) => key !== NO_GROUP)
      .map(([key, members]) => ({ key, label: labels.project(key), tasks: members }))
      .sort(byLabel);
    return none ? [{ key: NO_GROUP, label: "", tasks: none }, ...named] : named;
  }
  const groups = bucket(tasks, (task) => labels.assignee(task).trim() || NO_GROUP);
  const none = groups.get(NO_GROUP);
  const named = [...groups.entries()]
    .filter(([key]) => key !== NO_GROUP)
    .map(([key, members]) => ({ key, label: key, tasks: members }))
    .sort(byLabel);
  return none ? [...named, { key: NO_GROUP, label: "", tasks: none }] : named;
}

/** The Issues table sorts by everything the project board does, plus the two
    facts only a cross-project table shows. */
export type IssueSortKey = BacklogSortKey | "project" | "updated";

export function issueSortColumns(labels: IssueGroupLabels): readonly SortColumn<RelayTaskListItem, IssueSortKey>[] {
  return [
    ...backlogSortColumns(labels.assignee),
    {
      key: "project",
      compare: byText((task) => (task.projectId ? labels.project(task.projectId) : "")),
      isMissing: (task) => !task.projectId,
    },
    { key: "updated", compare: byDate((task) => task.updatedAt), defaultDirection: "desc" },
  ];
}
