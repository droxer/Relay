import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  taskAssignmentEditable,
  taskAssignmentOptions,
  taskAssignmentPatch,
} from "../src/lib/taskAssignment.js";
import type { AgentTeam, EmployeeAgent, ProjectRecord, RelayTaskListItem } from "../src/types.js";

function agent(id: string, computerId: string, supervisorEmployeeId?: string): EmployeeAgent {
  return {
    id, displayName: id, executorKind: "codex", supervisorEmployeeId,
    placements: [{ computerId, desiredState: "active" }],
  } as unknown as EmployeeAgent;
}

function team(id: string, memberAgentIds: string[], ownerEmployeeId = ""): AgentTeam {
  return { id, name: id, memberAgentIds, ownerEmployeeId } as unknown as AgentTeam;
}

const project = {
  id: "p", computerId: "c1", members: [{ agentId: "remote-member", enabled: true }],
} as unknown as ProjectRecord;

function task(over: Partial<RelayTaskListItem> = {}): RelayTaskListItem {
  return {
    id: "t", title: "T", status: "backlog", priority: "normal", projectId: "p", assigneeEmployeeId: "me",
    linkedSessionIds: [], createdAt: "", updatedAt: "", ...over,
  } as RelayTaskListItem;
}

const ids = (records: ReadonlyArray<{ id: string }>) => records.map((record) => record.id);

describe("task assignment rules", () => {
  it("offers agents and whole teams on the project's computer, plus enabled members", () => {
    const agents = [agent("here", "c1"), agent("away", "c2"), agent("remote-member", "c2"), agent("theirs", "c1", "someone-else")];
    const teams = [team("local", ["here"]), team("split", ["here", "away"])];
    const options = taskAssignmentOptions({ project, agents, teams, assigneeEmployeeId: "me" });
    assert.deepEqual(ids(options.agents), ["here", "remote-member"]);
    assert.deepEqual(ids(options.teams), ["local"]);
  });

  it("keeps the current pick listed even when it no longer qualifies", () => {
    const options = taskAssignmentOptions({
      project, agents: [agent("away", "c2")], teams: [team("split", ["away"])],
      assigneeEmployeeId: "me", assignedAgentId: "away", assignedTeamId: "split",
    });
    assert.deepEqual(ids(options.agents), ["away"]);
    assert.deepEqual(ids(options.teams), ["split"]);
  });

  it("edits assignment only before work starts, and never on an intake issue", () => {
    assert.equal(taskAssignmentEditable(task()), true);
    assert.equal(taskAssignmentEditable(task({ status: "assigned" })), true);
    assert.equal(taskAssignmentEditable(task({ status: "running" })), false);
    assert.equal(taskAssignmentEditable(task({ projectId: undefined })), false);
  });

  it("builds the same PATCH the task drawer sends for each kind of change", () => {
    // The server derives the assignee from the agent's supervisor, so it is not sent.
    assert.deepEqual(taskAssignmentPatch(task({ collaborationStyle: "build_review" }), { kind: "agent", id: "a" }),
      { assignedAgentId: "a", assignedTeamId: null, collaborationStyle: "" });
    assert.deepEqual(taskAssignmentPatch(task({ collaborationStyle: "solo" }), { kind: "team", id: "x" }),
      { assignedAgentId: null, assignedTeamId: "x", collaborationStyle: "build_review" });
    assert.deepEqual(taskAssignmentPatch(task(), { kind: "team", id: "x" }),
      { assignedAgentId: null, assignedTeamId: "x", collaborationStyle: "" });
    // A Ready task with nobody on it is not ready: it falls back to Backlog.
    assert.deepEqual(taskAssignmentPatch(task({ status: "assigned" }), { kind: "none" }),
      { assignedAgentId: null, assignedTeamId: null, collaborationStyle: "", status: "backlog" });
    assert.deepEqual(taskAssignmentPatch(task(), { kind: "none" }),
      { assignedAgentId: null, assignedTeamId: null, collaborationStyle: "" });
  });
});
