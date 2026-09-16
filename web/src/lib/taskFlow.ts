import type { RelayTaskListItem, TaskStatus } from "../types.js";

export const TASK_FLOW_STAGES = ["backlog", "assigned", "running", "review", "done"] as const;
export type TaskWorkflowStage = typeof TASK_FLOW_STAGES[number];
const DAY = 86_400_000;

export function taskWorkflowStage(task: RelayTaskListItem): TaskWorkflowStage {
  if (task.workflowStage) return task.workflowStage;
  if (task.status === "blocked" || task.status === "waiting_for_human") return "running";
  return task.status;
}

export function taskIsWip(task: RelayTaskListItem): boolean {
  return !task.isRoutine && !task.deletedAt && task.status !== "done"
    && (Boolean(task.startedAt) || ["running", "review", "waiting_for_human"].includes(task.status));
}

export function compareTaskQueue(left: RelayTaskListItem, right: RelayTaskListItem): number {
  const rank = { high: 0, normal: 1, low: 2 };
  return rank[left.priority] - rank[right.priority]
    || (left.dueDate ?? "9999-12-31").localeCompare(right.dueDate ?? "9999-12-31")
    || left.createdAt.localeCompare(right.createdAt)
    || left.id.localeCompare(right.id);
}

export function taskFlowMetrics(tasks: RelayTaskListItem[], now = Date.now()) {
  const live = tasks.filter((task) => !task.isRoutine && !task.deletedAt);
  const wip = live.filter(taskIsWip);
  const finished = live.filter((task) => task.status === "done" && task.finishedAt
    && Date.parse(task.finishedAt) >= now - 30 * DAY && Date.parse(task.finishedAt) <= now);
  const cycles = finished.filter((task) => task.startedAt).map((task) =>
    Math.max(0, (Date.parse(task.finishedAt!) - Date.parse(task.startedAt!)) / DAY),
  ).sort((a, b) => a - b);
  const sleIsEstimate = cycles.length < 20;
  return {
    wip: wip.length,
    throughput: finished.length,
    averageCycleDays: cycles.length ? cycles.reduce((a, b) => a + b, 0) / cycles.length : null,
    oldestAgeDays: Math.max(0, ...wip.filter((task) => task.startedAt).map((task) => (now - Date.parse(task.startedAt!)) / DAY)),
    sleDays: sleIsEstimate ? 8 : cycles[Math.ceil(cycles.length * 0.85) - 1],
    sleIsEstimate,
  };
}

/** Offered status edits never claim that an agent has started executing. */
export function manualTaskStatuses(status: TaskStatus, started: boolean): TaskStatus[] {
  if (status === "running" || status === "blocked") return [status];
  const candidates: TaskStatus[] = started ? ["assigned", "review"] : ["backlog", "assigned"];
  if (status === "review") candidates.push("done");
  return [...new Set([status, ...candidates])];
}

export function taskFlowErrorKey(code?: string): string | undefined {
  const keys: Record<string, string> = {
    task_wip_limit: "backlog.wip_wait",
    task_execution_active: "backlog.error_active",
    task_state_changed: "backlog.error_changed",
    task_transition_requires_execution: "backlog.error_start",
    task_review_requires_work: "backlog.error_review",
    task_acceptance_requires_review: "backlog.error_accept",
    task_started_cannot_return_to_backlog: "backlog.error_backlog",
    task_acceptance_policy_locked: "backlog.error_policy",
  };
  return code ? keys[code.split(":")[0]] : undefined;
}
