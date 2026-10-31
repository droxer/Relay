import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { homeNeedsYouCount, homeQueue, type HomeItem, type HomeQueueInput } from "../src/lib/homeQueue.js";
import type { DaemonNodeMonitorRecord, RelaySession, RelayTaskListItem } from "../src/types.js";

const ME = "alice";
const TODAY = "2026-10-31";

function task(input: Partial<RelayTaskListItem> & { id: string }): RelayTaskListItem {
  return {
    title: input.id,
    description: "",
    priority: "normal",
    status: "backlog",
    ownerUserId: ME,
    projectId: "p1",
    isRoutine: false,
    linkedSessionIds: [],
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    ...input,
  } as RelayTaskListItem;
}

function thread(input: Partial<RelaySession> & { id: string }): RelaySession {
  return {
    status: "completed",
    ownerUserId: ME,
    events: [],
    agentRuns: [],
    artifacts: [],
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    ...input,
  } as unknown as RelaySession;
}

function node(input: Partial<DaemonNodeMonitorRecord> & { id: string }): DaemonNodeMonitorRecord {
  return {
    userId: ME,
    status: "ready",
    agents: {},
    online: true,
    stale: false,
    queuedCommandCount: 0,
    activeRuns: [],
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    ...input,
  } as DaemonNodeMonitorRecord;
}

function queue(input: Partial<HomeQueueInput>): HomeItem[] {
  return homeQueue({ tasks: [], sessions: [], nodes: [], userId: ME, today: TODAY, ...input });
}

const keys = (items: HomeItem[]) => items.map((item) => item.key);

const question = task({
  id: "q",
  status: "waiting_for_human",
  updatedAt: "2026-10-30T09:00:00.000Z",
  awaiting: { questionId: "w1", kind: "question", text: "Which?", options: ["A", "B"], notes: [], sessionId: "s-q", resumable: true },
});
const review = task({ id: "r", status: "review", updatedAt: "2026-10-29T09:00:00.000Z" });
const blocked = task({ id: "b", status: "blocked", updatedAt: "2026-10-28T09:00:00.000Z" });
const overdue = task({ id: "o", status: "assigned", dueDate: "2026-10-30" });
const prompting = thread({
  id: "s-p",
  status: "running",
  permissionRequests: [{ id: "req1", runId: "run", agent: "claude", toolName: "Bash", input: "ls", requestedAt: "2026-10-31T08:00:00.000Z" }],
} as Partial<RelaySession> & { id: string });

describe("homeQueue", () => {
  it("ranks a paused run, then what needs you, then what is stuck, then what is worth doing", () => {
    const items = queue({ tasks: [overdue, blocked, review, question], sessions: [prompting] });

    assert.deepEqual(keys(items), ["permission:s-p:req1", "task:r", "task:q", "task:b", "task:o"]);
    assert.deepEqual(items.map((item) => item.tier), ["paused", "needs_you", "needs_you", "stuck", "worth_doing"]);
  });

  it("orders a tier oldest first", () => {
    const older = task({ id: "older", status: "review", updatedAt: "2026-10-01T00:00:00.000Z" });

    assert.deepEqual(keys(queue({ tasks: [review, older] })), ["task:older", "task:r"]);
  });

  it("names a task once, at its most urgent reason", () => {
    const lateReview = task({ id: "late", status: "review", dueDate: "2026-10-01" });

    const items = queue({ tasks: [lateReview] });

    assert.deepEqual(items.map((item) => item.kind), ["review"]);
  });

  it("leaves out work someone else is responsible for, routines, and finished work", () => {
    const tasks = [
      task({ id: "theirs", status: "review", assigneeUserId: "bob" }),
      task({ id: "template", status: "blocked", isRoutine: true }),
      task({ id: "finished", status: "done", dueDate: "2026-10-01" }),
      task({ id: "gone", status: "review", deletedAt: "2026-10-30T00:00:00.000Z" }),
    ];

    assert.deepEqual(queue({ tasks }), []);
  });

  it("ignores a wait a reply cannot resume", () => {
    const occurrence = task({ ...question, id: "occ", awaiting: { ...question.awaiting!, resumable: false } });

    assert.deepEqual(queue({ tasks: [occurrence] }), []);
  });

  it("gathers intake into one triage item", () => {
    const intake = [
      task({ id: "i1", projectId: undefined, createdAt: "2026-10-02T00:00:00.000Z" }),
      task({ id: "i2", projectId: undefined, createdAt: "2026-10-05T00:00:00.000Z" }),
    ];

    const [item] = queue({ tasks: intake });

    assert.equal(item.kind, "untriaged");
    assert.equal(item.kind === "untriaged" && item.tasks.length, 2);
    assert.equal(item.since, "2026-10-02T00:00:00.000Z");
  });

  it("flags an offline computer of yours only while work waits to start", () => {
    const dark = node({ id: "n1", online: false, lastSeenAt: "2026-10-31T07:00:00.000Z" });
    const waiting = task({ id: "a1", status: "assigned" });

    assert.deepEqual(queue({ nodes: [dark] }), []);
    assert.deepEqual(keys(queue({ nodes: [dark], tasks: [waiting] })), ["node:n1"]);
    assert.deepEqual(queue({ nodes: [{ ...dark, userId: "bob" }], tasks: [waiting] }), []);
    assert.deepEqual(queue({ nodes: [{ ...dark, retiredAt: "2026-10-30T00:00:00.000Z" }], tasks: [waiting] }), []);
  });

  it("offers a finished thread's first suggested next step", () => {
    const done = thread({ id: "s1", nextSteps: ["  Add an   alert ", "Write docs"] } as Partial<RelaySession> & { id: string });

    const [item] = queue({ sessions: [done] });

    assert.equal(item.kind, "suggested");
    assert.equal(item.kind === "suggested" && item.step, "Add an alert");
  });

  it("hides a snoozed item until its stamp changes", () => {
    const snoozes = [{ key: "task:r", stamp: review.updatedAt }];

    assert.deepEqual(queue({ tasks: [review], snoozes }), []);
    const changed = { ...review, updatedAt: "2026-10-31T10:00:00.000Z" };
    assert.deepEqual(keys(queue({ tasks: [changed], snoozes })), ["task:r"]);
  });

  it("counts only what needs you for the rail badge", () => {
    const items = queue({ tasks: [question, blocked, overdue], sessions: [prompting] });

    assert.equal(homeNeedsYouCount(items), 2);
  });
});
