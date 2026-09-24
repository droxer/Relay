import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  agentOnComputer,
  teamOnComputer,
  teamSharesOneComputer,
} from "../src/lib/taskAssignment.js";

type Placement = { computerId?: string; desiredState: "active" | "draining" | "removed" };

function agent(id: string, ...computerIds: string[]) {
  return {
    id,
    placements: computerIds.map((computerId): Placement => ({ computerId, desiredState: "active" })),
  };
}

function team(...memberAgentIds: string[]) {
  return { memberAgentIds };
}

describe("same-computer assignment", () => {
  it("places an agent on a computer through an active placement", () => {
    assert.equal(agentOnComputer(agent("a", "pc-1"), "pc-1"), true);
    assert.equal(agentOnComputer(agent("a", "pc-2"), "pc-1"), false);
  });

  it("ignores a placement the agent has left", () => {
    const moved = {
      id: "a",
      placements: [{ computerId: "pc-1", desiredState: "removed" as const }],
    };
    assert.equal(agentOnComputer(moved, "pc-1"), false);
  });

  it("accepts a team only when every member is on the computer", () => {
    const agents = [agent("lead", "pc-1"), agent("helper", "pc-1"), agent("far", "pc-2")];
    assert.equal(teamOnComputer(team("lead", "helper"), agents, "pc-1"), true);
    assert.equal(teamOnComputer(team("lead", "far"), agents, "pc-1"), false);
  });

  it("refuses a team whose member the roster does not know", () => {
    assert.equal(teamOnComputer(team("lead", "ghost"), [agent("lead", "pc-1")], "pc-1"), false);
    assert.equal(teamOnComputer(team(), [], "pc-1"), false);
  });

  it("finds a team that shares one computer without being told which", () => {
    const agents = [agent("lead", "pc-1"), agent("helper", "pc-1"), agent("far", "pc-2")];
    assert.equal(teamSharesOneComputer(team("lead", "helper"), agents), true);
    assert.equal(teamSharesOneComputer(team("lead", "far"), agents), false);
  });
});
