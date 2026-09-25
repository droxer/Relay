import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  agentComputerIds,
  agentsForTeamComputer,
  membersOffComputer,
  pruneMembershipToComputer,
  teamComputerId,
} from "../src/lib/teamComputer.js";
import type { AgentPlacement, EmployeeAgent } from "../src/types.js";

const HERE = "device:employee-1:here";
const THERE = "device:employee-1:there";

const placement = (overrides: Partial<AgentPlacement> = {}): AgentPlacement => ({
  id: "placement",
  agentId: "agent",
  employeeId: "employee-1",
  daemonNodeId: "node-1",
  executorKind: "codex",
  desiredState: "active",
  status: "ready",
  priority: 0,
  agentVersion: 1,
  workspacePolicy: {},
  conditions: [],
  createdAt: "2026-09-25T00:00:00Z",
  updatedAt: "2026-09-25T00:00:00Z",
  ...overrides,
});

const agent = (id: string, computerId: string, overrides: Partial<EmployeeAgent> = {}): EmployeeAgent => ({
  id,
  supervisorEmployeeId: "employee-1",
  displayName: id,
  executorKind: "codex",
  skillPolicy: {},
  toolPolicy: {},
  modelPolicy: {},
  enabled: true,
  version: 1,
  availability: "ready",
  placements: [placement({ agentId: id, computerId })],
  createdAt: "2026-09-25T00:00:00Z",
  updatedAt: "2026-09-25T00:00:00Z",
  ...overrides,
});

describe("agentComputerIds", () => {
  it("reads active placements and ignores draining ones", () => {
    const moving = agent("moving", HERE, {
      placements: [
        placement({ computerId: HERE }),
        placement({ computerId: THERE, desiredState: "draining" }),
      ],
    });
    assert.deepEqual(agentComputerIds(moving), [HERE]);
  });

  it("falls back to the computer the agent was created on", () => {
    assert.deepEqual(agentComputerIds(agent("fresh", HERE, { placements: [], computerId: THERE })), [THERE]);
  });
});

describe("agentsForTeamComputer", () => {
  it("offers only agents on the picked computer, keeping current members visible", () => {
    const agents = [agent("a", HERE), agent("b", THERE), agent("c", THERE), agent("gone", HERE, { deletedAt: "x" })];
    assert.deepEqual(
      agentsForTeamComputer(agents, HERE, ["c"]).map((entry) => entry.id),
      ["a", "c"],
    );
  });

  it("offers nobody before a computer is picked", () => {
    assert.deepEqual(agentsForTeamComputer([agent("a", HERE)], "", []), []);
  });
});

describe("membersOffComputer", () => {
  it("names the members the picked computer does not host", () => {
    const agents = [agent("a", HERE), agent("b", THERE)];
    assert.deepEqual(membersOffComputer(agents, HERE, ["a", "b"]), ["b"]);
  });
});

describe("pruneMembershipToComputer", () => {
  it("drops members off the computer and hands the lead to the next one", () => {
    const agents = [agent("a", THERE), agent("b", HERE), agent("c", HERE)];
    assert.deepEqual(
      pruneMembershipToComputer({ memberIds: ["a", "b", "c"], leadId: "a" }, agents, HERE),
      { memberIds: ["b", "c"], leadId: "b" },
    );
  });
});

describe("teamComputerId", () => {
  it("prefers the computer the team recorded", () => {
    assert.equal(teamComputerId({ computerId: THERE, memberAgentIds: ["a"] }, [agent("a", HERE)]), THERE);
  });

  it("derives a legacy team's computer from the roster", () => {
    const agents = [agent("a", HERE), agent("b", HERE)];
    assert.equal(teamComputerId({ memberAgentIds: ["a", "b"], leadAgentId: "a" }, agents), HERE);
  });

  it("falls back to the lead's computer for a legacy split team", () => {
    const agents = [agent("a", THERE), agent("b", HERE)];
    assert.equal(teamComputerId({ memberAgentIds: ["a", "b"], leadAgentId: "a" }, agents), THERE);
  });
});
