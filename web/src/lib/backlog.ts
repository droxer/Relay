import { compareTaskQueue, taskWorkflowStage } from "./taskFlow.ts";
import { byDate, byRank, byText, type SortColumn } from "./listSort.ts";
import type { AgentName, DaemonNodeMonitorRecord, EmployeeAgent, RelayTaskListItem, TaskPriority, TaskStatus } from "../types.js";

export const TASK_STATUSES: TaskStatus[] = ["backlog", "assigned", "running", "waiting_for_human", "review", "blocked", "done"];
export const TASK_PRIORITIES: TaskPriority[] = ["high", "normal", "low"];

export interface BacklogFilters {
  query: string;
  status: "all" | TaskStatus;
  priority: "all" | TaskPriority;
  agent: string;
  team: string;
  assignment: "all" | "assigned" | "unassigned";
  assignee: string;
  due: "all" | "overdue" | "today" | "next_week" | "unscheduled";
  /**
   * Where the task came from: anything (`all`), tasks a person wrote
   * (`direct`), or runs a routine generated (`routine`).
   *
   * A promoted occurrence is an ordinary task in every other respect, so
   * without this the board mixes work someone asked for with work a schedule
   * produced, and a daily routine can bury the former in the latter.
   */
  source: "all" | "direct" | "routine";
}

export function filterTasks(tasks: RelayTaskListItem[], filters: BacklogFilters, today = isoToday()): RelayTaskListItem[] {
  const query = filters.query.trim().toLowerCase();
  const assignee = filters.assignee.trim().toLowerCase();
  const nextWeek = new Date(`${today}T12:00:00`);
  nextWeek.setDate(nextWeek.getDate() + 7);
  const nextWeekEnd = localDateKey(nextWeek);
  return tasks.filter((task) => {
    if (task.isRoutine) return false;
    if (filters.source === "direct" && task.sourceRoutineId) return false;
    if (filters.source === "routine" && !task.sourceRoutineId) return false;
    if (filters.status !== "all") {
      const status = filters.status === "blocked" || filters.status === "waiting_for_human" ? task.status : taskWorkflowStage(task);
      if (status !== filters.status) return false;
    }
    if (filters.priority !== "all" && task.priority !== filters.priority) return false;
    if (filters.agent !== "all" && task.assignedAgentId !== filters.agent) return false;
    if (filters.team !== "all" && task.assignedTeamId !== filters.team) return false;
    const assigned = Boolean(task.assignedAgentId || task.assignedTeamId || task.assignedAgent);
    if (filters.assignment === "assigned" && !assigned) return false;
    if (filters.assignment === "unassigned" && assigned) return false;
    if (assignee && !(task.assigneeEmployeeId ?? task.ownerEmployeeId ?? "").toLowerCase().includes(assignee)) return false;
    if (query) {
      const haystack = `${task.title} ${task.description} ${task.id}`.toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    if (filters.due === "overdue" && (!task.dueDate || task.dueDate >= today || task.status === "done")) return false;
    if (filters.due === "today" && task.dueDate !== today) return false;
    if (filters.due === "next_week" && (!task.dueDate || task.dueDate < today || task.dueDate >= nextWeekEnd || task.status === "done")) return false;
    if (filters.due === "unscheduled" && task.dueDate) return false;
    return true;
  }).sort(compareTasks);
}

/** The keys the backlog list's sortable column headers speak. */
export type BacklogSortKey = "title" | "status" | "priority" | "assignee" | "due";

/**
 * Sortable columns for the backlog list, in header order.
 *
 * `assigneeName` is injected rather than read off the task because the row
 * prints a RESOLVED display name — sorting by `assigneeEmployeeId` would
 * order the list by a string the reader cannot see, which reads as no sort
 * at all. Same reason the enumerated columns rank by their domain order:
 * "high, low, normal" is alphabetical, not a priority ordering.
 */
export function backlogSortColumns(
  assigneeName: (task: RelayTaskListItem) => string,
): readonly SortColumn<RelayTaskListItem, BacklogSortKey>[] {
  return [
    { key: "title", compare: byText((task) => task.title) },
    { key: "status", compare: byRank((task) => task.status, TASK_STATUSES) },
    { key: "priority", compare: byRank((task) => task.priority, TASK_PRIORITIES) },
    {
      key: "assignee",
      compare: byText(assigneeName),
      isMissing: (task) => !assigneeName(task).trim(),
    },
    {
      key: "due",
      compare: byDate((task) => task.dueDate),
      // Undated is not "earliest". It sinks either way round.
      isMissing: (task) => !task.dueDate,
    },
  ];
}

export function isTaskStatus(value: string | null | undefined): value is TaskStatus {
  return typeof value === "string" && (TASK_STATUSES as string[]).includes(value);
}

export function tasksByStatus(tasks: RelayTaskListItem[]): Record<TaskStatus, RelayTaskListItem[]> {
  return TASK_STATUSES.reduce((acc, status) => {
    acc[status] = tasks.filter((task) => taskWorkflowStage(task) === status);
    return acc;
  }, {} as Record<TaskStatus, RelayTaskListItem[]>);
}

// Employee workflows use named logical-agent availability only. Legacy
// executor-only assignments stay visible but cannot be dispatched.
export function agentReadyForTask(
  task: RelayTaskListItem,
  _nodes: DaemonNodeMonitorRecord[],
  logicalAgents: EmployeeAgent[] = [],
): boolean {
  if (task.assignedAgentId) {
    return logicalAgents.some(
      (agent) => agent.id === task.assignedAgentId && agent.enabled && agent.availability === "ready",
    );
  }
  return false;
}

export function discussionAgentsForTask(
  _task: RelayTaskListItem,
  _nodes: DaemonNodeMonitorRecord[],
  logicalAgents: EmployeeAgent[] = [],
): AgentName[] {
  const readyLogicalAgents = logicalAgents.filter(
    (agent) => agent.enabled && agent.availability === "ready",
  );
  return [...new Set(readyLogicalAgents.map((agent) => agent.executorKind))];
}

export function canDiscussTask(task: Pick<RelayTaskListItem, "assignedTeamId">): boolean {
  return !task.assignedTeamId;
}

export function dueTone(task: RelayTaskListItem, today = isoToday()): "neutral" | "warn" | "bad" {
  if (!task.dueDate || task.status === "done") return "neutral";
  if (task.dueDate < today) return "bad";
  if (task.dueDate === today) return "warn";
  return "neutral";
}

export function localDateKey(date = new Date()): string {
  // Local-date key, not UTC — task due dates are entered as calendar days, so
  // toISOString() (UTC) flips "today" a day early/late for users far from UTC.
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export const isoToday = localDateKey;

const compareTasks = compareTaskQueue;
