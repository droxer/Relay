import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { homeQueue } from "../src/lib/homeQueue.js";
import { homeProjects, recentlyFinished, runningNow } from "../src/lib/homeSummary.js";
import type { DaemonNodeMonitorRecord, ProjectRecord, RelaySession, RelayTaskListItem } from "../src/types.js";

const ME = "alice";
const NOW = Date.parse("2026-10-31T12:00:00.000Z");

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

function project(id: string, name: string, extra: Partial<ProjectRecord> = {}): ProjectRecord {
  return { id, name, ownerUserId: ME, updatedAt: "2026-10-01T00:00:00.000Z", ...extra } as ProjectRecord;
}

describe("homeProjects", () => {
  it("puts projects that want you first and names each one's next step", () => {
    const tasks = [
      task({ id: "r", projectId: "p2", status: "review" }),
      task({ id: "x", projectId: "p1", status: "done" }),
      task({ id: "y", projectId: "p1", status: "running" }),
    ];
    const queue = homeQueue({ tasks, sessions: [], nodes: [], userId: ME, today: "2026-10-31" });

    const rows = homeProjects([project("p1", "Alpha"), project("p2", "Beta")], tasks, queue);

    assert.deepEqual(rows.map((row) => row.project.id), ["p2", "p1"]);
    assert.equal(rows[0].waitingOnYou, 1);
    assert.equal(rows[0].next?.key, "task:r");
    assert.equal(rows[1].next, null);
    assert.deepEqual(rows[1].progress, { done: 1, review: 0, running: 1, blocked: 0 });
  });

  it("leaves out archived projects", () => {
    const rows = homeProjects([project("p1", "Old", { archivedAt: "2026-10-01T00:00:00.000Z" })], [], []);

    assert.deepEqual(rows, []);
  });
});

describe("recentlyFinished", () => {
  it("lists my newest done work and leaves review to the queue", () => {
    const tasks = [
      task({ id: "old", status: "done", finishedAt: "2026-10-01T00:00:00.000Z" }),
      task({ id: "new", status: "done", finishedAt: "2026-10-31T00:00:00.000Z" }),
      task({ id: "review", status: "review", finishedAt: "2026-10-31T06:00:00.000Z" }),
      task({ id: "open", status: "running" }),
    ];

    assert.deepEqual(recentlyFinished(tasks, ME).map((item) => item.id), ["new", "old"]);
  });
});

describe("runningNow", () => {
  it("lists my running threads with when their run started and whether it waits on a prompt", () => {
    const sessions = [
      { id: "s1", status: "running", ownerUserId: ME, updatedAt: "2026-10-31T11:00:00.000Z", permissionRequests: [{ id: "q" }] },
      { id: "s2", status: "completed", ownerUserId: ME, updatedAt: "2026-10-31T11:00:00.000Z" },
    ] as unknown as RelaySession[];
    const nodes = [{
      id: "n1",
      activeRuns: [{ sessionId: "s1", startedAt: "2026-10-31T10:00:00.000Z", logicalAgentId: "agent-1", agent: "claude" }],
    }] as unknown as DaemonNodeMonitorRecord[];

    const [row, ...rest] = runningNow(sessions, nodes, ME);

    assert.equal(rest.length, 0);
    assert.equal(row.session.id, "s1");
    assert.equal(row.startedAt, "2026-10-31T10:00:00.000Z");
    assert.equal(row.agentId, "agent-1");
    assert.equal(row.computerId, "n1");
    assert.equal(row.paused, true);
  });

  it("trusts the execution phase over a stale running status, as the thread rail does", () => {
    const sessions = [
      // An orphan from before execution tracking: the list reads it terminal.
      { id: "orphan", status: "running", ownerUserId: ME, updatedAt: "2026-09-16T00:00:00.000Z", execution: { phase: "terminal" } },
      { id: "queued", status: "completed", ownerUserId: ME, updatedAt: "2026-10-31T11:00:00.000Z", execution: { phase: "queued" } },
      // No execution record and no run on any computer: nothing proves it runs.
      { id: "legacy", status: "running", ownerUserId: ME, updatedAt: "2026-10-31T11:00:00.000Z" },
      { id: "deleting", status: "running", ownerUserId: ME, updatedAt: "2026-10-31T11:00:00.000Z", deletionRequestedAt: "2026-10-31T11:30:00.000Z", execution: { phase: "stopping" } },
    ] as unknown as RelaySession[];

    assert.deepEqual(runningNow(sessions, [], ME).map((row) => row.session.id), ["queued"]);
  });
});
