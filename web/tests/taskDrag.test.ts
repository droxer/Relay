import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { laneForDropTarget, taskDropRejection } from "../src/lib/taskDrag.js";
import type { RelayTask } from "../src/types.js";

function task(input: Partial<RelayTask> & { id: string }): RelayTask {
  return {
    id: input.id,
    title: input.title ?? "Task",
    description: "",
    priority: "normal",
    status: input.status ?? "backlog",
    ownerEmployeeId: "alice",
    isRoutine: false,
    routineEnabled: false,
    assignedAgentId: input.assignedAgentId,
    assignedTeamId: input.assignedTeamId,
    linkedSessionIds: [],
    activity: [],
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    events: [],
  } as RelayTask;
}

describe("taskDropRejection", () => {
  it("rejects a drop on the lane the task already sits in", () => {
    assert.equal(taskDropRejection(task({ id: "a", status: "review" }), "review"), "same_status");
  });

  it("rejects the assigned lane while the task has no agent or team", () => {
    assert.equal(taskDropRejection(task({ id: "a" }), "assigned"), "needs_assignment");
  });

  it("accepts the assigned lane once an agent or a team owns the task", () => {
    assert.equal(taskDropRejection(task({ id: "a", assignedAgentId: "agent_builder" }), "assigned"), null);
    assert.equal(taskDropRejection(task({ id: "b", assignedTeamId: "team_delivery" }), "assigned"), null);
  });

  it("refuses moving a running task through manual workflow edits", () => {
    const running = task({ id: "a", status: "running" });
    assert.equal(taskDropRejection(running, "done"), "invalid_transition");
    assert.equal(taskDropRejection(running, "blocked"), "invalid_transition");
    assert.equal(taskDropRejection(running, "backlog"), "invalid_transition");
    assert.equal(taskDropRejection(task({ id: "b", status: "done" }), "backlog"), null);
  });
});

describe("laneForDropTarget", () => {
  const lanes = {
    backlog: [task({ id: "task_1" })],
    assigned: [],
    running: [task({ id: "task_2", status: "running" })],
  } as const;

  it("resolves a lane dropped on directly, even when it is empty", () => {
    assert.equal(laneForDropTarget("assigned", lanes), "assigned");
  });

  it("resolves a card to the lane that holds it", () => {
    assert.equal(laneForDropTarget("task_2", lanes), "running");
  });

  it("returns null for nothing, or for an id no lane knows", () => {
    assert.equal(laneForDropTarget(null, lanes), null);
    assert.equal(laneForDropTarget("task_missing", lanes), null);
  });
});
