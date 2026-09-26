import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ISSUE_QUEUES,
  groupIssues,
  issueNeedsProject,
  issueQueueCounts,
  issuesInQueue,
  parseIssueGroupBy,
  parseIssueQueue,
} from "../src/lib/issueQueues.js";
import type { RelayTaskListItem } from "../src/types.js";

const TODAY = "2026-09-26";
const ME = "alice";

function issue(input: Partial<RelayTaskListItem> & { id: string }): RelayTaskListItem {
  return {
    title: input.id,
    description: "",
    priority: "normal",
    status: "backlog",
    ownerEmployeeId: ME,
    isRoutine: false,
    linkedSessionIds: [],
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...input,
  } as RelayTaskListItem;
}

const loose = issue({ id: "loose" });
const looseDone = issue({ id: "loose-done", status: "done" });
const occurrence = issue({ id: "occurrence", sourceRoutineId: "routine-1" });
const review = issue({ id: "review", projectId: "p1", status: "review" });
const othersReview = issue({ id: "others-review", projectId: "p1", status: "review", assigneeEmployeeId: "bob" });
const waiting = issue({ id: "waiting", projectId: "p2", status: "waiting_for_human", assigneeEmployeeId: ME });
const blocked = issue({ id: "blocked", projectId: "p1", status: "blocked" });
const running = issue({ id: "running", projectId: "p2", status: "running" });
const overdue = issue({ id: "overdue", projectId: "p1", dueDate: "2026-09-20" });
const overdueDone = issue({ id: "overdue-done", projectId: "p1", status: "done", dueDate: "2026-09-20" });
const routine = issue({ id: "routine", isRoutine: true });
const all = [loose, looseDone, occurrence, review, othersReview, waiting, blocked, running, overdue, overdueDone, routine];

const ids = (tasks: RelayTaskListItem[]) => tasks.map((task) => task.id).sort();

describe("issue queues", () => {
  it("an issue outside a project needs one, but a routine run never does", () => {
    assert.equal(issueNeedsProject(loose), true);
    assert.equal(issueNeedsProject(occurrence), false);
    assert.equal(issueNeedsProject(routine), false);
    assert.equal(issueNeedsProject(review), false);
  });

  it("needs me is human-gated work that is mine", () => {
    assert.deepEqual(ids(issuesInQueue(all, "needs_me", { employeeId: ME, today: TODAY })), ["review", "waiting"]);
  });

  it("untriaged is open intake outside a project", () => {
    assert.deepEqual(ids(issuesInQueue(all, "untriaged", { employeeId: ME, today: TODAY })), ["loose"]);
  });

  it("overdue ignores finished work", () => {
    assert.deepEqual(ids(issuesInQueue(all, "overdue", { employeeId: ME, today: TODAY })), ["overdue"]);
  });

  it("open and done partition every issue, and routine templates are never issues", () => {
    const open = issuesInQueue(all, "open", { employeeId: ME, today: TODAY });
    const done = issuesInQueue(all, "done", { employeeId: ME, today: TODAY });
    assert.equal(open.length + done.length, all.length - 1);
    assert.ok(!open.concat(done).some((task) => task.isRoutine));
  });

  it("counts every queue", () => {
    const counts = issueQueueCounts(all, { employeeId: ME, today: TODAY });
    assert.deepEqual(Object.keys(counts).sort(), [...ISSUE_QUEUES].sort());
    assert.equal(counts.blocked, 1);
    assert.equal(counts.running, 1);
  });

  it("parses unknown params back to the defaults", () => {
    assert.equal(parseIssueQueue("nope"), "open");
    assert.equal(parseIssueQueue("blocked"), "blocked");
    assert.equal(parseIssueGroupBy(null), "project");
    assert.equal(parseIssueGroupBy("assignee"), "assignee");
  });
});

describe("groupIssues", () => {
  const label = {
    project: (id: string) => ({ p1: "Alpha", p2: "Beta" } as Record<string, string>)[id] ?? id,
    assignee: (task: RelayTaskListItem) => task.assigneeEmployeeId ?? "",
  };

  it("groups by project with the no-project group first", () => {
    const groups = groupIssues([running, loose, overdue, review], "project", label);
    assert.deepEqual(groups.map((group) => group.key), ["none", "p1", "p2"]);
    assert.deepEqual(groups.map((group) => group.tasks.length), [1, 2, 1]);
    assert.equal(groups[1].label, "Alpha");
  });

  it("groups by status in workflow order and keeps empty statuses out", () => {
    const groups = groupIssues([blocked, loose, running], "status", label);
    assert.deepEqual(groups.map((group) => group.key), ["backlog", "running", "blocked"]);
  });

  it("groups by assignee with unassigned last", () => {
    const groups = groupIssues([waiting, othersReview, loose], "assignee", label);
    assert.deepEqual(groups.map((group) => group.key), ["alice", "bob", "none"]);
  });

  it("none is one ungrouped band", () => {
    const groups = groupIssues([waiting, loose], "none", label);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].tasks.length, 2);
  });
});
