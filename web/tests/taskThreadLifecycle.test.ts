import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { placeLifecycleMarkers, threadLifecycleMarkers } from "../src/lib/taskThreadLifecycle.js";
import type { RelayTaskEvent, TaskStatus } from "../src/types.js";

const TASK = "tsk_1";
const THREAD = "ses_1";
const ME = "usr_me";

function created(timestamp: string): RelayTaskEvent {
  return { id: `created-${timestamp}`, type: "task.created", taskId: TASK, timestamp, title: "Ship", description: "", priority: "normal" };
}

function status(timestamp: string, to: TaskStatus, extra: { actorUserId?: string; reason?: string; sessionId?: string } = {}): RelayTaskEvent {
  return { id: `status-${timestamp}`, type: "task.status", taskId: TASK, timestamp, status: to, ...extra };
}

function linked(timestamp: string, sessionId: string): RelayTaskEvent {
  return { id: `linked-${timestamp}`, type: "task.session_linked", taskId: TASK, timestamp, sessionId };
}

const window = { sessionId: THREAD, sessionCreatedAt: "2026-10-18T10:00:00.000Z", currentUserId: ME };

describe("threadLifecycleMarkers", () => {
  it("opens on how the run was queued and follows every move the thread saw", () => {
    const events = [
      created("2026-10-18T09:00:00.000Z"),
      status("2026-10-18T09:50:00.000Z", "assigned", { actorUserId: ME }),
      linked("2026-10-18T10:00:00.000Z", THREAD),
      status("2026-10-18T10:00:01.000Z", "running"),
      status("2026-10-18T10:05:00.000Z", "review"),
      status("2026-10-18T10:30:00.000Z", "done", { actorUserId: "usr_other" }),
    ];

    const markers = threadLifecycleMarkers(events, window);

    assert.deepEqual(
      markers.map((m) => [m.from, m.to, m.actor]),
      [
        ["backlog", "assigned", "you"],
        ["assigned", "running", "relay"],
        ["running", "review", "relay"],
        ["review", "done", "teammate"],
      ],
    );
  });

  it("skips repeats of the status the task already had", () => {
    const events = [
      status("2026-10-18T10:00:01.000Z", "running"),
      status("2026-10-18T10:00:02.000Z", "running"),
    ];
    assert.equal(threadLifecycleMarkers(events, window).length, 1);
  });

  it("counts an execution claim as Relay making the task Ready", () => {
    const events: RelayTaskEvent[] = [
      { id: "claim", type: "task.execution.claimed", taskId: TASK, timestamp: "2026-10-18T09:59:00.000Z", requestId: "r", expectedRevision: 1, revision: 2 },
      status("2026-10-18T10:00:01.000Z", "running"),
    ];
    const markers = threadLifecycleMarkers(events, window);
    assert.deepEqual(markers.map((m) => [m.to, m.actor]), [["assigned", "relay"], ["running", "relay"]]);
  });

  it("keeps a blocker's reason", () => {
    const events = [status("2026-10-18T10:01:00.000Z", "blocked", { reason: "Computer offline" })];
    assert.equal(threadLifecycleMarkers(events, window)[0].reason, "Computer offline");
  });

  it("leaves moves after a later thread took over to that thread", () => {
    const events = [
      status("2026-10-18T10:00:01.000Z", "running"),
      status("2026-10-18T10:10:00.000Z", "waiting_for_human", { sessionId: THREAD }),
      linked("2026-10-18T11:00:00.000Z", "ses_2"),
      status("2026-10-18T11:00:01.000Z", "running"),
    ];
    assert.deepEqual(threadLifecycleMarkers(events, window).map((m) => m.to), ["running", "waiting_for_human"]);
  });

  it("drops a wait parked in another thread", () => {
    const events = [
      status("2026-10-18T10:00:01.000Z", "running"),
      status("2026-10-18T10:10:00.000Z", "waiting_for_human", { sessionId: "ses_other" }),
    ];
    assert.deepEqual(threadLifecycleMarkers(events, window).map((m) => m.to), ["running"]);
  });

  it("shows only the last move before a thread nobody queued", () => {
    const events = [
      status("2026-10-18T08:00:00.000Z", "blocked"),
      status("2026-10-18T09:00:00.000Z", "backlog", { actorUserId: ME }),
    ];
    assert.deepEqual(threadLifecycleMarkers(events, window).map((m) => m.to), ["backlog"]);
  });
});

describe("placeLifecycleMarkers", () => {
  const messages = [
    { id: "goal", timestamp: "2026-10-18T10:00:00.000Z" },
    { id: "agent", timestamp: "2026-10-18T10:00:02.000Z" },
  ];
  const marker = (timestamp: string, to: TaskStatus) => ({ id: timestamp, timestamp, from: "backlog" as const, to, actor: "relay" as const });

  it("draws each move above the first turn not older than it and the rest after the last turn", () => {
    const placed = placeLifecycleMarkers(messages, [
      marker("2026-10-18T09:50:00.000Z", "assigned"),
      marker("2026-10-18T10:00:01.000Z", "running"),
      marker("2026-10-18T10:05:00.000Z", "review"),
    ]);
    assert.deepEqual(placed.before.get("goal")?.map((m) => m.to), ["assigned"]);
    assert.deepEqual(placed.before.get("agent")?.map((m) => m.to), ["running"]);
    assert.deepEqual(placed.trailing.map((m) => m.to), ["review"]);
  });

  it("trails every move when there are no messages yet", () => {
    const placed = placeLifecycleMarkers([], [marker("2026-10-18T10:00:01.000Z", "running")]);
    assert.equal(placed.before.size, 0);
    assert.equal(placed.trailing.length, 1);
  });
});
