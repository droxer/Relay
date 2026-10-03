import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { projectIssueMetrics } from "../src/lib/projectDashboard.js";
import type { RelayTaskListItem } from "../src/types.js";

const NOW = Date.parse("2026-10-04T12:00:00Z");

const task = (overrides: Partial<RelayTaskListItem>): RelayTaskListItem => ({
  id: "t",
  title: "Task",
  status: "backlog",
  priority: "normal",
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-01T00:00:00Z",
  ...overrides,
} as RelayTaskListItem);

describe("project issue metrics", () => {
  it("counts live issues and leaves routines and deleted issues out", () => {
    const metrics = projectIssueMetrics([
      task({ id: "a" }),
      task({ id: "b", status: "blocked", startedAt: "2026-10-03T12:00:00Z" }),
      task({ id: "c", isRoutine: true }),
      task({ id: "d", deletedAt: "2026-10-02T00:00:00Z" }),
    ], "2026-10-04", NOW);
    assert.equal(metrics.total, 2);
    assert.equal(metrics.blocked, 1);
    assert.equal(metrics.active, 1);
    assert.equal(metrics.oldestAgeDays, 1);
  });

  it("counts open issues past their due date as overdue", () => {
    const metrics = projectIssueMetrics([
      task({ id: "late", dueDate: "2026-10-01" }),
      task({ id: "today", dueDate: "2026-10-04" }),
      task({ id: "done-late", status: "done", dueDate: "2026-10-01" }),
    ], "2026-10-04", NOW);
    assert.equal(metrics.overdue, 1);
  });

  it("reports no age and an estimated SLE for an empty project", () => {
    const metrics = projectIssueMetrics([], "2026-10-04", NOW);
    assert.equal(metrics.total, 0);
    assert.equal(metrics.oldestAgeDays, null);
    assert.equal(metrics.averageCycleDays, null);
    assert.equal(metrics.sleIsEstimate, true);
  });
});
