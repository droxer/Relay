import assert from "node:assert/strict";
import { test } from "node:test";
import { materializeTaskEvents, relayTaskEvent } from "../../packages/relay-core/src/task-store.js";
import { taskFlowMetrics, taskWorkflowStage, compareTaskQueue, taskFlowErrorKey, manualTaskStatuses } from "../src/lib/taskFlow.js";

function task(status: "running" | "review" | "blocked" | "done") {
  return materializeTaskEvents([
    { ...relayTaskEvent("task.created", "task", { title: "Work", description: "", priority: "normal" }), timestamp: "2026-09-01T00:00:00Z" },
    { ...relayTaskEvent("task.status", "task", { status: "running" }), timestamp: "2026-09-02T00:00:00Z" },
    { ...relayTaskEvent("task.status", "task", { status: "review" }), timestamp: "2026-09-03T00:00:00Z" },
    { ...relayTaskEvent("task.status", "task", { status, reason: "Approval" }), timestamp: "2026-09-04T00:00:00Z" },
  ]);
}

test("blocked review stays in review and is unfinished WIP", () => {
  const blocked = task("blocked");
  assert.equal(taskWorkflowStage(blocked), "review");
  assert.equal(blocked.startedAt, "2026-09-02T00:00:00Z");
  assert.equal(blocked.blockerReason, "Approval");
  const metrics = taskFlowMetrics([blocked], Date.parse("2026-09-12T00:00:00Z"));
  assert.equal(metrics.wip, 1);
  assert.equal(metrics.oldestAgeDays, 10);
  assert.equal(metrics.throughput, 0);
});

test("flow metrics count task deliveries and cycle time including review", () => {
  const metrics = taskFlowMetrics([task("done"), { ...task("review"), id: "other" }], Date.parse("2026-09-12T00:00:00Z"));
  assert.equal(metrics.wip, 1);
  assert.equal(metrics.throughput, 1);
  assert.equal(metrics.averageCycleDays, 2);
  assert.equal(metrics.sleIsEstimate, true);
});

test("queue ties are oldest first and edits do not change precedence", () => {
  const old = { ...task("review"), createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-13T00:00:00Z" };
  const next = { ...old, id: "next", createdAt: "2026-09-02T00:00:00Z" };
  assert.ok(compareTaskQueue(old, next) < 0);
});

test("workflow errors give actionable messages and edits cannot claim execution", () => {
  assert.equal(taskFlowErrorKey("task_wip_limit: no capacity"), "backlog.wip_wait");
  assert.equal(taskFlowErrorKey("task_state_changed: reload"), "backlog.error_changed");
  assert.equal(taskFlowErrorKey("unknown"), undefined);
  assert.deepEqual(manualTaskStatuses("running", true), ["running"]);
  assert.deepEqual(manualTaskStatuses("blocked", true), ["blocked"]);
  assert.deepEqual(manualTaskStatuses("backlog", false), ["backlog", "assigned"]);
  assert.ok(manualTaskStatuses("review", true).includes("done"));
});

test("an admitted but not yet running execution stays in Ready", () => {
  const admitted = materializeTaskEvents([
    relayTaskEvent("task.created", "queued", { title: "Queued", description: "", priority: "normal" }),
    relayTaskEvent("task.status", "queued", { status: "assigned" }),
    relayTaskEvent("task.execution.claimed", "queued", { requestId: "request", expectedRevision: 0, revision: 1 }),
  ]);

  assert.ok(admitted.startedAt);
  assert.equal(taskWorkflowStage(admitted), "assigned");
});

test("oldest WIP age is unknown, not zero, when no work in progress has started", () => {
  const unstarted = { ...task("review"), id: "unstarted", startedAt: undefined };
  assert.equal(taskFlowMetrics([], Date.parse("2026-09-12T00:00:00Z")).oldestAgeDays, null);
  assert.equal(taskFlowMetrics([unstarted], Date.parse("2026-09-12T00:00:00Z")).oldestAgeDays, null);
});
