import type { RelayTaskListItem } from "../types.js";
import { dueTone, isoToday } from "./backlog.ts";
import { taskFlowMetrics } from "./taskFlow.ts";

export interface ProjectIssueMetrics {
  total: number;
  active: number;
  blocked: number;
  overdue: number;
  oldestAgeDays: number | null;
  throughput: number;
  averageCycleDays: number | null;
  sleDays: number;
  sleIsEstimate: boolean;
}

/** The project Dashboard's readings over its issues. Routines and deleted
 *  issues are not the board's work, so they count toward nothing. */
export function projectIssueMetrics(
  tasks: readonly RelayTaskListItem[],
  today = isoToday(),
  now = Date.now(),
): ProjectIssueMetrics {
  const issues = tasks.filter((task) => !task.isRoutine && !task.deletedAt);
  const flow = taskFlowMetrics(issues, now);
  return {
    total: issues.length,
    active: flow.wip,
    blocked: issues.filter((task) => task.status === "blocked").length,
    overdue: issues.filter((task) => dueTone(task, today) === "bad").length,
    oldestAgeDays: flow.oldestAgeDays,
    throughput: flow.throughput,
    averageCycleDays: flow.averageCycleDays,
    sleDays: flow.sleDays,
    sleIsEstimate: flow.sleIsEstimate,
  };
}
