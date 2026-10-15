import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { teamsForThreadNode, threadNodeOffline } from "../src/lib/threadRuntime.js";

type TestNode = {
  id: string;
  managedNodeId?: string;
  retiredAt?: string;
  userId?: string;
  online: boolean;
  stale: boolean;
  status: string;
};

function node(overrides: Partial<TestNode> = {}): TestNode {
  return {
    id: "sbx_alice",
    userId: "alice",
    online: true,
    stale: false,
    status: "ready",
    ...overrides,
  };
}

function session(overrides: Record<string, unknown> = {}) {
  return { daemonNodeId: "sbx_alice", agentRuns: [], ...overrides };
}

describe("threadNodeOffline", () => {
  it("is false when the pinned computer is online and fresh", () => {
    assert.equal(threadNodeOffline(session(), [], [node()]), false);
  });

  it("is true when the pinned computer is offline", () => {
    assert.equal(threadNodeOffline(session(), [], [node({ online: false })]), true);
  });

  it("is true when the pinned computer heartbeat is stale", () => {
    assert.equal(threadNodeOffline(session(), [], [node({ stale: true })]), true);
  });

  it("is true when the pinned computer has left the fleet", () => {
    assert.equal(threadNodeOffline(session(), [], []), true);
  });

  it("is true when the pinned computer is retired", () => {
    const retired = node({ retiredAt: "2026-06-12T00:00:00.000Z" });
    assert.equal(threadNodeOffline(session(), [], [retired]), true);
  });

  it("is false when the thread names no computer", () => {
    assert.equal(threadNodeOffline({ agentRuns: [] }, [], [node()]), false);
    assert.equal(threadNodeOffline(undefined, [], [node()]), false);
  });

  it("follows the managed-node fallback to a healthy replacement", () => {
    const offline = node({ id: "sbx_old", managedNodeId: "mn_1", online: false });
    const replacement = node({ id: "sbx_new", managedNodeId: "mn_1" });
    assert.equal(
      threadNodeOffline(session({ daemonNodeId: "sbx_old" }), [], [offline, replacement]),
      false,
    );
  });

  it("is true when every managed-node candidate is offline", () => {
    const offline = node({ id: "sbx_old", managedNodeId: "mn_1", online: false });
    const alsoOffline = node({ id: "sbx_new", managedNodeId: "mn_1", online: false });
    assert.equal(
      threadNodeOffline(session({ daemonNodeId: "sbx_old" }), [], [offline, alsoOffline]),
      true,
    );
  });
});

type TestAgent = {
  id: string;
  placements: ReadonlyArray<{ daemonNodeId: string; desiredState: string }>;
};

function agent(id: string, ...nodeIds: string[]): TestAgent {
  return {
    id,
    placements: nodeIds.map((daemonNodeId) => ({ daemonNodeId, desiredState: "active" })),
  };
}

function team(overrides: Record<string, unknown> = {}) {
  return { id: "team_1", memberAgentIds: ["agent_a", "agent_b"], ...overrides };
}

describe("teamsForThreadNode", () => {
  const agents = [
    agent("agent_a", "sbx_alice"),
    agent("agent_b", "sbx_alice"),
    agent("agent_c", "sbx_bob"),
  ];

  it("returns no teams when no computer is selected", () => {
    assert.deepEqual(teamsForThreadNode([team()], agents, null), []);
    assert.deepEqual(teamsForThreadNode([team()], agents, undefined), []);
  });

  it("keeps a team whose whole roster is placed on the computer", () => {
    const teams = teamsForThreadNode([team()], agents, "sbx_alice");
    assert.deepEqual(teams.map((item) => item.id), ["team_1"]);
  });

  it("drops a team when any member is hosted elsewhere", () => {
    const split = team({ id: "team_split", memberAgentIds: ["agent_a", "agent_c"] });
    assert.deepEqual(teamsForThreadNode([split], agents, "sbx_alice"), []);
    assert.deepEqual(teamsForThreadNode([split], agents, "sbx_bob"), []);
  });

  it("drops a team whose member agent is unknown", () => {
    const ghost = team({ memberAgentIds: ["agent_a", "agent_gone"] });
    assert.deepEqual(teamsForThreadNode([ghost], agents, "sbx_alice"), []);
  });

  it("drops deleted and empty teams", () => {
    const deleted = team({ id: "team_deleted", deletedAt: "2026-06-12T00:00:00.000Z" });
    const empty = team({ id: "team_empty", memberAgentIds: [] });
    assert.deepEqual(teamsForThreadNode([deleted, empty], agents, "sbx_alice"), []);
  });

  it("ignores placements that are not active", () => {
    const removed = {
      id: "agent_a",
      placements: [{ daemonNodeId: "sbx_alice", desiredState: "removed" }],
    };
    assert.deepEqual(teamsForThreadNode([team()], [removed, agents[1]], "sbx_alice"), []);
  });
});
