import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, it } from "node:test";

import { agentMatchesQuery } from "../src/lib/agentSearch.js";
import { groupAgentsByComputer, UNPLACED_GROUP_KEY } from "../src/lib/agentGroups.js";
import type { AgentPlacement, EmployeeAgent } from "../src/types.js";

const read = (path: string) => readFile(resolve("web", path), "utf8");

function placement(
  input: Partial<AgentPlacement> & Pick<AgentPlacement, "id" | "daemonNodeId">,
): AgentPlacement {
  return {
    id: input.id,
    agentId: input.agentId ?? "agent_alice",
    employeeId: input.employeeId ?? "alice",
    daemonNodeId: input.daemonNodeId,
    runtimeNodeId: input.runtimeNodeId,
    computerId: input.computerId,
    executorKind: input.executorKind ?? "codex",
    desiredState: input.desiredState ?? "active",
    status: input.status ?? "ready",
    priority: input.priority ?? 100,
    agentVersion: 1,
    workspacePolicy: {},
    conditions: [],
    createdAt: "2026-09-01T00:00:00Z",
    updatedAt: "2026-09-01T00:00:00Z",
    nodeDisplayName: input.nodeDisplayName,
    nodeOwnership: input.nodeOwnership,
    nodeSandboxMode: input.nodeSandboxMode,
  };
}

function agent(id: string, placements: AgentPlacement[]): EmployeeAgent {
  return {
    id,
    supervisorEmployeeId: "alice",
    displayName: id,
    executorKind: "codex",
    enabled: true,
    availability: "ready",
    placements,
    createdAt: "2026-09-01T00:00:00Z",
    updatedAt: "2026-09-01T00:00:00Z",
  } as EmployeeAgent;
}

describe("groupAgentsByComputer", () => {
  it("bands agents under the computer they run on, ordered by computer name", () => {
    const laptop = placement({
      id: "p_laptop",
      daemonNodeId: "node_laptop",
      computerId: "computer_laptop",
      nodeDisplayName: "Alice’s MacBook",
      nodeOwnership: "employee-device",
    });
    const managed = placement({
      id: "p_managed",
      daemonNodeId: "node_managed",
      computerId: "computer_managed",
      nodeDisplayName: "Build box",
      nodeOwnership: "managed",
    });

    const groups = groupAgentsByComputer([
      agent("reviewer", [laptop]),
      agent("builder", [managed]),
    ]);

    assert.deepEqual(
      groups.map((group) => ({ key: group.key, label: group.label, agents: group.agents.map((a) => a.id) })),
      [
        { key: "computer_laptop", label: "Alice’s MacBook", agents: ["reviewer"] },
        { key: "computer_managed", label: "Build box", agents: ["builder"] },
      ],
    );
  });

  it("keeps the caller's order inside a band and lists an agent under every computer it runs on", () => {
    const laptop = placement({ id: "p1", daemonNodeId: "n1", computerId: "c_laptop", nodeDisplayName: "Laptop" });
    const box = placement({ id: "p2", daemonNodeId: "n2", computerId: "c_box", nodeDisplayName: "Box", priority: 200 });
    const groups = groupAgentsByComputer([
      agent("zeta", [laptop]),
      agent("alpha", [laptop, box]),
    ]);

    const box_ = groups.find((group) => group.key === "c_box");
    const laptop_ = groups.find((group) => group.key === "c_laptop");
    assert.deepEqual(laptop_?.agents.map((a) => a.id), ["zeta", "alpha"]);
    assert.deepEqual(box_?.agents.map((a) => a.id), ["alpha"]);
  });

  it("drops removed placements and sinks unplaced agents into a trailing band", () => {
    const removed = placement({
      id: "p_removed",
      daemonNodeId: "node_gone",
      computerId: "computer_gone",
      nodeDisplayName: "Retired box",
      desiredState: "removed",
    });
    const live = placement({ id: "p_live", daemonNodeId: "node_live", computerId: "c_live", nodeDisplayName: "Zed box" });

    const groups = groupAgentsByComputer([
      agent("orphan", [removed]),
      agent("worker", [live]),
    ]);

    assert.deepEqual(groups.map((group) => group.key), ["c_live", UNPLACED_GROUP_KEY]);
    assert.deepEqual(groups[1].agents.map((a) => a.id), ["orphan"]);
    assert.equal(groups[1].label, null);
  });

  it("falls back to the runtime node identity when a placement carries no computer id", () => {
    const groups = groupAgentsByComputer([
      agent("legacy", [placement({ id: "p", daemonNodeId: "node_legacy" })]),
    ]);
    assert.deepEqual(groups.map((group) => ({ key: group.key, label: group.label })), [
      { key: "node_legacy", label: "node_legacy" },
    ]);
  });

  it("coalesces legacy and stable placements on the same computer", () => {
    const stableComputerId = "device:alice:machine-a";
    const legacyAgent = {
      ...agent("legacy", [placement({
        id: "p_legacy",
        daemonNodeId: "node_current",
        nodeDisplayName: "Alice's MacBook",
      })]),
      computerId: stableComputerId,
    };
    const currentAgent = {
      ...agent("current", [placement({
        id: "p_current",
        daemonNodeId: "node_current",
        computerId: stableComputerId,
        nodeDisplayName: "Alice's MacBook",
      })]),
      computerId: stableComputerId,
    };

    const groups = groupAgentsByComputer([legacyAgent, currentAgent]);

    assert.deepEqual(
      groups.map((group) => ({
        key: group.key,
        label: group.label,
        agents: group.agents.map((entry) => entry.id),
      })),
      [{
        key: stableComputerId,
        label: "Alice's MacBook",
        agents: ["legacy", "current"],
      }],
    );
  });
});

describe("agents roster grouping", () => {
  it("renders one band per computer instead of a single flat list", async () => {
    const source = await read("src/components/AgentsPage.tsx");
    assert.match(source, /groupAgentsByComputer\(/);
    assert.match(source, /agents-roster-group-label/);
    // The band names the computer, so the row must not restate it.
    assert.match(source, /showComputers=\{false\}/);
  });
});

describe("agentMatchesQuery", () => {
  const box = placement({
    id: "p_box",
    daemonNodeId: "node_box",
    computerId: "c_box",
    nodeDisplayName: "Build box",
  });

  it("matches the computer the agent runs on, now that the roster bands by it", () => {
    const worker = agent("reviewer", [box]);
    assert.equal(agentMatchesQuery(worker, "codex reviewer", "build box"), true);
    assert.equal(agentMatchesQuery(worker, "codex reviewer", "BUILD"), true);
  });

  it("ignores a computer the agent no longer runs on", () => {
    const retired = agent("reviewer", [
      placement({
        id: "p_gone",
        daemonNodeId: "node_gone",
        computerId: "c_gone",
        nodeDisplayName: "Retired box",
        desiredState: "removed",
      }),
    ]);
    assert.equal(agentMatchesQuery(retired, "codex reviewer", "retired"), false);
  });

  it("keeps matching the name, id, runtime, blurb and instructions", () => {
    const worker = { ...agent("reviewer", [box]), instructions: "reviews migrations" };
    assert.equal(agentMatchesQuery(worker, "codex blurb", "reviewer"), true);
    assert.equal(agentMatchesQuery(worker, "codex blurb", "codex"), true);
    assert.equal(agentMatchesQuery(worker, "codex blurb", "blurb"), true);
    assert.equal(agentMatchesQuery(worker, "codex blurb", "migrations"), true);
    assert.equal(agentMatchesQuery(worker, "codex blurb", "nothing here"), false);
  });

  it("matches everything on an empty query", () => {
    assert.equal(agentMatchesQuery(agent("reviewer", []), "", "   "), true);
  });
});
