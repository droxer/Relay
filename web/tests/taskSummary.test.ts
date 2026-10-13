import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { mergeTaskSummaryIntoTasks, taskSummaryFromTask } from "../src/lib/taskSummary.js";
import type { RelayTask, RelayTaskSummary } from "../src/types.js";

describe("task summary projection", () => {
  it("keeps board fields while removing authoritative histories", () => {
    const task = {
      id: "task_1",
      title: "Keep the board fast",
      description: "",
      priority: "normal",
      status: "backlog",
      isRoutine: false,
      linkedSessionIds: [],
      createdAt: "2026-08-02T00:00:00.000Z",
      updatedAt: "2026-08-02T00:00:01.000Z",
      activity: [{
        id: "act_1",
        createdAt: "2026-08-02T00:00:01.000Z",
        message: "Updated",
      }],
      events: [{
        id: "evt_1",
        type: "task.created",
        taskId: "task_1",
        timestamp: "2026-08-02T00:00:00.000Z",
        title: "Keep the board fast",
        description: "",
        priority: "normal",
      }],
    } as RelayTask;

    const summary = taskSummaryFromTask(task);

    assert.equal(summary.eventCount, 1);
    assert.equal(summary.activityCount, 1);
    assert.equal("events" in summary, false);
    assert.equal("activity" in summary, false);
    assert.equal(summary.title, task.title);
  });

  it("does not let an older mutation response roll the list cache backward", () => {
    const newer = {
      id: "task_1",
      title: "Newest title",
      eventCount: 3,
      activityCount: 0,
      updatedAt: "2026-08-02T00:00:03.000Z",
    } as RelayTaskSummary;
    const older = {
      ...newer,
      title: "Stale title",
      eventCount: 2,
      updatedAt: "2026-08-02T00:00:02.000Z",
    };

    assert.deepEqual(mergeTaskSummaryIntoTasks([newer], older), [newer]);
  });

  it("accepts a newer task summary and prepends an unseen task", () => {
    const current = {
      id: "task_1",
      title: "Old title",
      eventCount: 1,
      activityCount: 0,
      updatedAt: "2026-08-02T00:00:01.000Z",
    } as RelayTaskSummary;
    const newer = { ...current, title: "New title", eventCount: 2 };
    const unseen = { ...current, id: "task_2" };

    assert.deepEqual(mergeTaskSummaryIntoTasks([current], newer), [newer]);
    assert.deepEqual(mergeTaskSummaryIntoTasks([current], unseen), [unseen, current]);
  });
});
