import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { projectTaskProgress, projectTaskQueue } from "../src/lib/projectTasks.js";
import type { RelayTaskListItem } from "../src/types.js";

function task(overrides: Partial<RelayTaskListItem> & Pick<RelayTaskListItem, "id">): RelayTaskListItem {
  return {
    title: `Task ${overrides.id}`,
    description: "",
    priority: "normal",
    status: "backlog",
    isRoutine: false,
    routineEnabled: false,
    linkedSessionIds: [],
    createdAt: "2026-09-01T00:00:00Z",
    updatedAt: "2026-09-01T00:00:00Z",
    ...overrides,
  } as RelayTaskListItem;
}

describe("projectTaskQueue", () => {
  it("keeps only the project's live, non-routine tasks", () => {
    const queue = projectTaskQueue(
      [
        task({ id: "mine" , projectId: "p1" }),
        task({ id: "other", projectId: "p2" }),
        task({ id: "loose" }),
        task({ id: "routine", projectId: "p1", isRoutine: true }),
        task({ id: "gone", projectId: "p1", deletedAt: "2026-09-02T00:00:00Z" }),
      ],
      "p1",
    );
    assert.deepEqual(queue.map((entry) => entry.id), ["mine"]);
  });

  it("orders by the shared task queue comparator", () => {
    const queue = projectTaskQueue(
      [
        task({ id: "low", projectId: "p1", priority: "low" }),
        task({ id: "high", projectId: "p1", priority: "high" }),
        task({ id: "normal", projectId: "p1", priority: "normal" }),
      ],
      "p1",
    );
    assert.deepEqual(queue.map((entry) => entry.id), ["high", "normal", "low"]);
  });
});

describe("projectTaskProgress", () => {
  it("counts completion and the work that needs a human", () => {
    const progress = projectTaskProgress([
      task({ id: "a", status: "done" }),
      task({ id: "b", status: "blocked" }),
      task({ id: "c", status: "waiting_for_human" }),
      task({ id: "d", status: "running" }),
    ]);
    assert.deepEqual(progress, { done: 1, total: 4, attention: 2, percent: 25 });
  });

  it("reports an empty project as zero rather than NaN", () => {
    assert.deepEqual(projectTaskProgress([]), { done: 0, total: 0, attention: 0, percent: 0 });
  });
});
