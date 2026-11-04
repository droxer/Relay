import { expect, it } from "vitest";
import { compareTaskQueue, isFlowStage, taskFlowErrorKey, taskFlowMetrics, taskHoldAction, taskWorkflowStage } from "../src/lib/taskFlow";
import { parseTaskCapacity } from "../src/lib/taskCapacity";
import type { RelayTaskListItem } from "../src/types";

const day = 86400000;
const now = Date.parse("2026-11-04T00:00:00Z");
const task = (fields: Partial<RelayTaskListItem>): RelayTaskListItem => ({
  id: "t", title: "Work", priority: "normal", status: "backlog", createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z", ...fields,
} as RelayTaskListItem);

it("capacity waits and cancelled work do not count as WIP or delivery", () => {
  const result = taskFlowMetrics([
    task({ status: "queued", workflowStage: "queued" }),
    task({ status: "cancelled", startedAt: new Date(now - day).toISOString(), cancelledAt: new Date(now).toISOString() }),
    task({ status: "review" }),
    task({ status: "running", isRoutine: true }),
    task({ status: "running", deletedAt: new Date(now).toISOString() }),
  ], now);
  expect(result.wip).toBe(1);
  expect(result.throughput).toBe(0);
  expect(result.oldestAgeDays).toBeNull();
  expect(result.averageCycleDays).toBeNull();
  expect(result.sleIsEstimate).toBe(true);
});

it("reports the observed delivery percentile once twenty accepted samples exist", () => {
  const samples = Array.from({ length: 20 }, (_, i) => task({
    id: String(i), status: "done", finishedAt: new Date(now).toISOString(), startedAt: new Date(now - (i + 1) * day).toISOString(),
  }));
  const result = taskFlowMetrics([...samples, task({ status: "done", finishedAt: new Date(now + day).toISOString() })], now);
  expect(result.sleIsEstimate).toBe(false);
  expect(result.sleDays).toBe(17);
  expect(result.throughput).toBe(20);
  expect(result.averageCycleDays).toBe(10.5);
});

it("keeps legacy waits readable and terminal work out of hold actions", () => {
  expect(taskWorkflowStage(task({ status: "blocked" }))).toBe("running");
  expect(taskWorkflowStage(task({ status: "waiting_for_human" }))).toBe("running");
  expect(taskWorkflowStage(task({ status: "queued", workflowStage: "queued" }))).toBe("queued");
  expect(taskWorkflowStage(task({ status: "backlog" }))).toBe("backlog");
  for (const status of ["cancelled", "done", "running"] as const) expect(taskHoldAction(task({ status }))).toBeNull();
  expect(taskHoldAction(task({ isRoutine: true }))).toBeNull();
  expect(taskHoldAction(task({ status: "blocked" }))).toBe("unblock");
  expect(taskHoldAction(task({ status: "queued" }))).toBe("block");
  expect(isFlowStage("queued")).toBe(true);
  expect(isFlowStage("cancelled")).toBe(true);
  expect(isFlowStage("unknown")).toBe(false);
  expect(taskFlowErrorKey("task_wip_limit: full")).toBe("backlog.wip_wait");
  expect(taskFlowErrorKey("unknown")).toBeUndefined();
  expect(taskFlowErrorKey()).toBeUndefined();
});

it("keeps priority, due date, age, and id precedence across queued tasks", () => {
  expect(compareTaskQueue(task({ priority: "high" }), task({ priority: "low" }))).toBeLessThan(0);
  expect(compareTaskQueue(task({ dueDate: "2026-11-01" }), task({}))).toBeLessThan(0);
  expect(compareTaskQueue(task({ createdAt: "2026-10-01" }), task({}))).toBeLessThan(0);
  expect(compareTaskQueue(task({ id: "a" }), task({ id: "b" }))).toBeLessThan(0);
});

it("accepts bounded task capacity overrides and distinguishes clearing from invalid input", () => {
  expect(parseTaskCapacity("5")).toBe(5);
  expect(parseTaskCapacity("100")).toBe(100);
  expect(parseTaskCapacity("")).toBeNull();
  for (const input of ["0", "101", "-1", "1.5", "abc"]) expect(parseTaskCapacity(input)).toBeUndefined();
});
