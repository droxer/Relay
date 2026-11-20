import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  isSettledTaskStatus,
  nodeAvailabilitySignature,
  RELAY_POLL_INTERVALS_MS,
  sessionsPollIntervalMs,
  taskRecordPollIntervalMs,
  taskWorkspaceStatusPollIntervalMs,
} from "../src/lib/relayPolling.js";
import {
  isSessionStreamConnected,
  setSessionStreamConnected,
  subscribeSessionStream,
} from "../src/lib/sessionStreamStatus.js";

describe("relay polling budget", () => {
  it("keeps freshness-critical reads fast without hot-polling stable resources", () => {
    assert.equal(RELAY_POLL_INTERVALS_MS.sessions, 5_000);
    assert.equal(RELAY_POLL_INTERVALS_MS.nodes, 15_000);
    assert.equal(RELAY_POLL_INTERVALS_MS.tasks, 10_000);
    assert.equal(RELAY_POLL_INTERVALS_MS.sandboxes, 30_000);
  });

  it("polls projects and rosters only as a backstop to invalidation", () => {
    assert.ok(RELAY_POLL_INTERVALS_MS.projects >= 300_000);
    assert.ok(RELAY_POLL_INTERVALS_MS.agents >= 300_000);
    assert.ok(RELAY_POLL_INTERVALS_MS.teams >= 300_000);
  });

  it("backs the sessions poll off only while the SSE tail is connected", () => {
    assert.equal(sessionsPollIntervalMs(false), RELAY_POLL_INTERVALS_MS.sessions);
    assert.equal(sessionsPollIntervalMs(true), 15_000);
    assert.ok(sessionsPollIntervalMs(true) > sessionsPollIntervalMs(false));
  });

  it("stops polling a task record once it settles", () => {
    assert.equal(isSettledTaskStatus("done"), true);
    assert.equal(isSettledTaskStatus("blocked"), true);
    assert.equal(isSettledTaskStatus(undefined), false);
    for (const status of ["backlog", "assigned", "running", "waiting_for_human", "review"] as const) {
      assert.equal(taskRecordPollIntervalMs(status), RELAY_POLL_INTERVALS_MS.tasks, status);
    }
    assert.equal(taskRecordPollIntervalMs("done"), false);
    assert.equal(taskRecordPollIntervalMs(undefined), RELAY_POLL_INTERVALS_MS.tasks);
  });

  it("keeps a slow poll on a settled record the polled list does not carry", () => {
    // A deep-linked task beyond the list's page has no list row to signal a
    // retry or reopen, so it cannot stop polling outright.
    assert.equal(taskRecordPollIntervalMs("done", false), RELAY_POLL_INTERVALS_MS.settledTaskRecord);
    assert.equal(taskRecordPollIntervalMs("blocked", false), RELAY_POLL_INTERVALS_MS.settledTaskRecord);
    assert.equal(taskRecordPollIntervalMs("done", true), false);
    assert.equal(taskRecordPollIntervalMs("running", false), RELAY_POLL_INTERVALS_MS.tasks);
  });

  it("watches workspace status while a note shows or the task can still run", () => {
    const fast = RELAY_POLL_INTERVALS_MS.tasks;
    assert.equal(taskWorkspaceStatusPollIntervalMs({ waiting: true, taskStatus: "done" }), fast);
    assert.equal(taskWorkspaceStatusPollIntervalMs({ waiting: false, taskStatus: "running" }), fast);
    assert.equal(taskWorkspaceStatusPollIntervalMs({ waiting: undefined, taskStatus: undefined }), fast);
    assert.equal(taskWorkspaceStatusPollIntervalMs({ waiting: false, taskStatus: "done" }), false);
    assert.equal(taskWorkspaceStatusPollIntervalMs({ waiting: false, taskStatus: "blocked" }), false);
  });
});

describe("session stream status", () => {
  it("notifies subscribers only when the connection flips", () => {
    let calls = 0;
    const unsubscribe = subscribeSessionStream(() => { calls += 1; });
    setSessionStreamConnected(true);
    setSessionStreamConnected(true);
    assert.equal(isSessionStreamConnected(), true);
    setSessionStreamConnected(false);
    assert.equal(calls, 2);
    unsubscribe();
    setSessionStreamConnected(true);
    assert.equal(calls, 2);
    setSessionStreamConnected(false);
  });
});

describe("nodeAvailabilitySignature", () => {
  const node = { id: "n1", status: "ready", online: true, dispatchable: true, agents: { claude: "ready", codex: "failed" } };

  it("ignores order and fields that do not decide availability", () => {
    const other = { id: "n2", status: "ready", online: false, agents: {} };
    const reordered = { ...node, agents: { codex: "failed", claude: "ready" }, lastSeenAgeMs: 4_000, queuedCommandCount: 2 };
    assert.equal(nodeAvailabilitySignature([node, other]), nodeAvailabilitySignature([other, reordered]));
  });

  it("changes when liveness, dispatchability, or a runtime's readiness changes", () => {
    const base = nodeAvailabilitySignature([node]);
    assert.notEqual(nodeAvailabilitySignature([{ ...node, online: false }]), base);
    assert.notEqual(nodeAvailabilitySignature([{ ...node, dispatchable: false }]), base);
    assert.notEqual(nodeAvailabilitySignature([{ ...node, agents: { ...node.agents, codex: "ready" } }]), base);
    assert.notEqual(nodeAvailabilitySignature([{ ...node, status: "stopped" }]), base);
    assert.notEqual(nodeAvailabilitySignature([]), base);
  });
});
