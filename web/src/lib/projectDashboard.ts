import type { RelayTaskListItem } from "../types.js";
import { dueTone, isoToday } from "./backlog.ts";
import { TASK_FLOW_STAGES, taskFlowMetrics, taskWorkflowStage, type TaskWorkflowStage } from "./taskFlow.ts";

export interface ProjectIssueMetrics {
  total: number;
  active: number;
  blocked: number;
  overdue: number;
  done: number;
  stages: Record<TaskWorkflowStage, number>;
  oldestAgeDays: number | null;
  throughput: number;
  averageCycleDays: number | null;
  sleDays: number;
  sleIsEstimate: boolean;
}

export interface ProjectAttentionIssue {
  task: RelayTaskListItem;
  reason: "blocked" | "overdue";
  /** Past its due date — also true of a blocked issue that is late. */
  overdue: boolean;
}

export const PROJECT_ATTENTION_LIMIT = 5;

/* Routines and deleted issues are not the board's work, so they count toward
   nothing on the Dashboard. */
const liveIssues = (tasks: readonly RelayTaskListItem[]) =>
  tasks.filter((task) => !task.isRoutine && !task.deletedAt);

/** The project Dashboard's readings over its issues. */
export function projectIssueMetrics(
  tasks: readonly RelayTaskListItem[],
  today = isoToday(),
  now = Date.now(),
): ProjectIssueMetrics {
  const issues = liveIssues(tasks);
  const flow = taskFlowMetrics(issues, now);
  const stages = Object.fromEntries(TASK_FLOW_STAGES.map((stage) => [
    stage,
    issues.filter((task) => taskWorkflowStage(task) === stage).length,
  ])) as Record<TaskWorkflowStage, number>;
  return {
    total: issues.length,
    active: flow.wip,
    blocked: issues.filter((task) => task.status === "blocked").length,
    overdue: issues.filter((task) => dueTone(task, today) === "bad").length,
    done: stages.done,
    stages,
    oldestAgeDays: flow.oldestAgeDays,
    throughput: flow.throughput,
    averageCycleDays: flow.averageCycleDays,
    sleDays: flow.sleDays,
    sleIsEstimate: flow.sleIsEstimate,
  };
}

/** The issues the Dashboard asks someone to look at: blocked ones first, then
 *  overdue ones, the longest-overdue first. A blocked issue that is also
 *  overdue is named once, as blocked — unblocking it is the action either way. */
export function projectAttentionIssues(
  tasks: readonly RelayTaskListItem[],
  today = isoToday(),
  limit = PROJECT_ATTENTION_LIMIT,
): ProjectAttentionIssue[] {
  const issues = liveIssues(tasks);
  const isOverdue = (task: RelayTaskListItem) => dueTone(task, today) === "bad";
  const blocked = issues
    .filter((task) => task.status === "blocked")
    .map((task) => ({ task, reason: "blocked" as const, overdue: isOverdue(task) }));
  const overdue = issues
    .filter((task) => task.status !== "blocked" && isOverdue(task))
    .sort((left, right) => left.dueDate!.localeCompare(right.dueDate!))
    .map((task) => ({ task, reason: "overdue" as const, overdue: true }));
  return [...blocked, ...overdue].slice(0, limit);
}
