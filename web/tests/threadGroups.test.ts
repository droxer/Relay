import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { groupThreads } from "../src/lib/threadGroups.js";
import type { ThreadItem } from "../src/lib/threads.js";
import type { AgentName, RelaySession } from "../src/types.js";

function item(
  id: string,
  status: RelaySession["status"],
  runningAgent?: AgentName,
): ThreadItem {
  const session = {
    id,
    workspacePath: "/workspace",
    ownerEmployeeId: "alice",
    taskGoal: `goal ${id}`,
    participants: ["human", "claude"],
    status,
    phase: status,
    createdAt: "2026-07-01T12:00:00.000Z",
    updatedAt: "2026-07-01T12:00:00.000Z",
    agentRuns: [],
    artifacts: [],
    decisions: [],
    events: [],
  } as unknown as RelaySession;
  return { session, runningAgent };
}

describe("groupThreads", () => {
  it("routes waiting_for_human to needsYou", () => {
    const { needsYou, running, idle } = groupThreads([item("a", "waiting_for_human")]);
    assert.deepEqual(needsYou.map((c) => c.session.id), ["a"]);
    assert.equal(running.length, 0);
    assert.equal(idle.length, 0);
  });

  it("routes running status to running", () => {
    const { running } = groupThreads([item("a", "running")]);
    assert.deepEqual(running.map((c) => c.session.id), ["a"]);
  });

  it("treats a live runningAgent as running even when status is not running", () => {
    const { running } = groupThreads([item("a", "completed", "claude")]);
    assert.deepEqual(running.map((c) => c.session.id), ["a"]);
  });

  it("routes completed/failed/cancelled to idle", () => {
    const { idle } = groupThreads([
      item("a", "completed"),
      item("b", "failed"),
      item("c", "cancelled"),
    ]);
    assert.deepEqual(idle.map((c) => c.session.id), ["a", "b", "c"]);
  });

  it("preserves input order within each group", () => {
    const { needsYou } = groupThreads([
      item("x", "waiting_for_human"),
      item("y", "running"),
      item("z", "waiting_for_human"),
    ]);
    assert.deepEqual(needsYou.map((c) => c.session.id), ["x", "z"]);
  });
});

describe("groupThreads awaiting an answer", () => {
  function settled(id: string, status: RelaySession["status"]): ThreadItem {
    const base = item(id, status);
    return { ...base, session: { ...base.session, workOutcome: "blocked" } };
  }

  it("routes a round that stopped to ask to needsYou", () => {
    // The backend closes such a session `completed` with workOutcome
    // "blocked"; it is waiting on its human, not finished.
    const { needsYou, idle } = groupThreads([settled("a", "completed")]);
    assert.deepEqual(needsYou.map((c) => c.session.id), ["a"]);
    assert.equal(idle.length, 0);
  });

  it("keeps a failed thread idle even though its outcome reads blocked", () => {
    const { needsYou, idle } = groupThreads([settled("a", "failed")]);
    assert.equal(needsYou.length, 0);
    assert.deepEqual(idle.map((c) => c.session.id), ["a"]);
  });
});
