import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { projectAttentionIssues, projectIssueMetrics } from "../src/lib/projectDashboard.js";
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

  it("spreads live issues across the board's stages and counts what is done", () => {
    const metrics = projectIssueMetrics([
      task({ id: "a" }),
      task({ id: "b", status: "assigned" }),
      task({ id: "c", status: "blocked" }),
      task({ id: "d", status: "review" }),
      task({ id: "e", status: "done" }),
      task({ id: "f", status: "done" }),
      task({ id: "g", status: "done", isRoutine: true }),
    ], "2026-10-04", NOW);
    assert.deepEqual(metrics.stages, { backlog: 1, assigned: 1, running: 1, review: 1, done: 2 });
    assert.equal(metrics.done, 2);
  });
});

describe("project attention issues", () => {
  it("lists blocked issues first, then overdue ones by how late they are", () => {
    const issues = projectAttentionIssues([
      task({ id: "fine", dueDate: "2026-10-09" }),
      task({ id: "late-2", dueDate: "2026-10-03" }),
      task({ id: "late-1", dueDate: "2026-09-20" }),
      task({ id: "stuck", status: "blocked" }),
      task({ id: "done-late", status: "done", dueDate: "2026-09-01" }),
      task({ id: "routine-late", isRoutine: true, dueDate: "2026-09-01" }),
    ], "2026-10-04");
    assert.deepEqual(issues.map((item) => [item.task.id, item.reason]), [
      ["stuck", "blocked"],
      ["late-1", "overdue"],
      ["late-2", "overdue"],
    ]);
  });

  it("names a blocked overdue issue once, as blocked", () => {
    const issues = projectAttentionIssues([
      task({ id: "both", status: "blocked", dueDate: "2026-10-01" }),
    ], "2026-10-04");
    assert.deepEqual(issues.map((item) => [item.reason, item.overdue]), [["blocked", true]]);
  });

  it("caps the list", () => {
    const tasks = Array.from({ length: 8 }, (_, index) => task({ id: `b${index}`, status: "blocked" }));
    assert.equal(projectAttentionIssues(tasks, "2026-10-04", 5).length, 5);
  });
});
