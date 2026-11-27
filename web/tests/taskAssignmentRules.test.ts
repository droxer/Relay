import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  assignmentComputerId,
  projectRoomAgentIds,
  projectThreadRoster,
  taskAssignmentEditable,
  taskAssignmentOptions,
  taskAssignmentPatch,
} from "../src/lib/taskAssignment.js";
import type { AgentTeam, UserAgent, ProjectRecord, RelayTaskListItem } from "../src/types.js";

function agent(id: string, computerId: string, supervisorUserId?: string): UserAgent {
  return {
    id, displayName: id, executorKind: "codex", supervisorUserId,
    placements: [{ computerId, desiredState: "active" }],
  } as unknown as UserAgent;
}

function team(id: string, memberAgentIds: string[], ownerUserId = ""): AgentTeam {
  return { id, name: id, memberAgentIds, ownerUserId } as unknown as AgentTeam;
}

const project = {
  id: "p", computerId: "c1", members: [{ agentId: "remote-member", enabled: true }],
} as unknown as ProjectRecord;

function task(over: Partial<RelayTaskListItem> = {}): RelayTaskListItem {
  return {
    id: "t", title: "T", status: "backlog", priority: "normal", projectId: "p", assigneeUserId: "me",
    linkedSessionIds: [], createdAt: "", updatedAt: "", ...over,
  } as RelayTaskListItem;
}

const ids = (records: ReadonlyArray<{ id: string }>) => records.map((record) => record.id);

describe("task assignment rules", () => {
  it("offers only enabled Project roster Agents and no Teams", () => {
    const agents = [agent("here", "c1"), agent("away", "c2"), agent("remote-member", "c2"), agent("theirs", "c1", "someone-else")];
    const teams = [team("local", ["here"]), team("split", ["here", "away"])];
    const options = taskAssignmentOptions({ project, agents, teams, assigneeUserId: "me" });
    assert.deepEqual(ids(options.agents), ["remote-member"]);
    assert.deepEqual(ids(options.teams), []);
  });

  it("excludes a current assignment outside the Project roster", () => {
    const options = taskAssignmentOptions({
      project, agents: [agent("away", "c2")], teams: [team("split", ["away"])],
      assigneeUserId: "me", assignedAgentId: "away", assignedTeamId: "split",
    });
    assert.deepEqual(ids(options.agents), []);
    assert.deepEqual(ids(options.teams), []);
  });

  it("filters disabled members and mixed teams, including current selections", () => {
    const roster = { ...project, members: [
      { agentId: "here", enabled: true }, { agentId: "disabled", enabled: false },
    ] } as ProjectRecord;
    const agents = [agent("here", "c1"), agent("disabled", "c1"), agent("outsider", "c1")];
    const options = taskAssignmentOptions({
      project: roster, agents,
      teams: [team("valid", ["here"]), team("disabled", ["here", "disabled"]), team("mixed", ["here", "outsider"])],
      assigneeUserId: "me", assignedAgentId: "disabled", assignedTeamId: "mixed",
    });
    assert.deepEqual(ids(options.agents), ["here"]);
    assert.deepEqual(ids(options.teams), []);
  });

  it("excludes stale selections outside the standalone Computer scope", () => {
    const agents = [agent("here", "c1"), agent("away", "c2")];
    const options = taskAssignmentOptions({
      computerId: "c1", agents, teams: [team("local", ["here"])],
      assigneeUserId: "me", assignedAgentId: "away",
    });
    assert.deepEqual(ids(options.agents), ["here"]);
    assert.deepEqual(ids(options.teams), ["local"]);
  });

  it("keeps Project members and their ordinary Teams eligible for standalone work", () => {
    const agents = [agent("member", "c1", "me")];
    const options = taskAssignmentOptions({ computerId: "c1", agents, teams: [team("ordinary", ["member"], "me")], assigneeUserId: "me" });
    assert.deepEqual(ids(options.agents), ["member"]);
    assert.deepEqual(ids(options.teams), ["ordinary"]);
  });

  it("edits assignment only before work starts, and never on an intake issue", () => {
    assert.equal(taskAssignmentEditable(task()), true);
    assert.equal(taskAssignmentEditable(task({ status: "assigned" })), true);
    assert.equal(taskAssignmentEditable(task({ status: "running" })), false);
    assert.equal(taskAssignmentEditable(task({ projectId: undefined })), false);
  });

  it("builds the same PATCH the task drawer sends for each kind of change", () => {
    assert.deepEqual(taskAssignmentPatch(task(), { kind: "workflow", id: "w" }),
      { assignedAgentId: null, assignedTeamId: null, assignedWorkflowId: "w", collaborationStyle: "" });
    // The server derives the assignee from the agent's supervisor, so it is not sent.
    assert.deepEqual(taskAssignmentPatch(task({ collaborationStyle: "build_review" }), { kind: "agent", id: "a" }),
      { assignedAgentId: "a", assignedTeamId: null, assignedWorkflowId: null, collaborationStyle: "" });
    assert.deepEqual(taskAssignmentPatch(task({ collaborationStyle: "solo" }), { kind: "team", id: "x" }),
      { assignedAgentId: null, assignedTeamId: "x", assignedWorkflowId: null, collaborationStyle: "build_review" });
    assert.deepEqual(taskAssignmentPatch(task(), { kind: "team", id: "x" }),
      { assignedAgentId: null, assignedTeamId: "x", assignedWorkflowId: null, collaborationStyle: "" });
    // A Ready task with nobody on it is not ready: it falls back to Backlog.
    assert.deepEqual(taskAssignmentPatch(task({ status: "assigned" }), { kind: "none" }),
      { assignedAgentId: null, assignedTeamId: null, assignedWorkflowId: null, collaborationStyle: "", status: "backlog" });
    assert.deepEqual(taskAssignmentPatch(task(), { kind: "none" }),
      { assignedAgentId: null, assignedTeamId: null, assignedWorkflowId: null, collaborationStyle: "" });
  });
});

describe("project thread roster", () => {
  const crewed = {
    computerId: "c1", leadAgentId: "lead",
    members: [
      { agentId: "builder", enabled: true },
      { agentId: "lead", enabled: true },
      { agentId: "benched", enabled: false },
    ],
  } as unknown as ProjectRecord;
  const agents = [agent("lead", "c1"), agent("builder", "c1"), agent("benched", "c1"), agent("alex", "c1"), agent("away", "c2")];

  it("puts the crew first, then every other agent on the project's computer", () => {
    assert.deepEqual(projectThreadRoster(crewed, agents), {
      leadAgentId: "lead",
      memberAgentIds: ["builder", "lead", "alex"],
    });
  });

  it("addresses the computer's agents in a project without a crew", () => {
    const crewless = { computerId: "c1", leadAgentId: null, members: [] } as unknown as ProjectRecord;
    assert.deepEqual(projectThreadRoster(crewless, agents), {
      leadAgentId: null,
      memberAgentIds: ["lead", "builder", "benched", "alex"],
    });
  });

  it("sends a bare message to the crew, or to the thread's agents without one", () => {
    const crewless = { computerId: "c1", leadAgentId: null, members: [] } as unknown as ProjectRecord;
    assert.deepEqual(projectRoomAgentIds(crewed, { participantAgentIds: ["alex"] }), ["builder", "lead"]);
    assert.deepEqual(projectRoomAgentIds(crewless, { participantAgentIds: ["alex"] }), ["alex"]);
    assert.deepEqual(projectRoomAgentIds(crewless, { ownerAgentId: "alex" }), ["alex"]);
    assert.deepEqual(projectRoomAgentIds(crewless, undefined), []);
  });
});

describe("Project workflow Task options", () => {
  it("never offers legacy Workflow Teams for Task assignment", () => {
    const agents = [agent("here", "c1")];
    const workflow = { ...team("workflow", ["here"], "me"), projectId: "p", workflowSteps: [{ id: "design" }] } as AgentTeam;
    const matching = { ...project, members: [{ agentId: "here", enabled: true }] } as ProjectRecord;
    const options = { agents, teams: [workflow], assigneeUserId: "me", assignedTeamId: "workflow" };
    assert.deepEqual(ids(taskAssignmentOptions({ ...options, project: matching }).teams), []);
    const foreign = { ...matching, id: "other" };
    assert.deepEqual(ids(taskAssignmentOptions({ ...options, project: foreign }).teams), []);
    assert.deepEqual(ids(taskAssignmentOptions(options).teams), []);
  });

  it("derives the Computer for a standalone Agent or Team assignment", () => {
    const active = agent("active", "c1");
    const draining = {
      id: "draining", displayName: "draining", executorKind: "codex",
      placements: [{ computerId: "c2", desiredState: "draining" }],
    } as unknown as UserAgent;
    const recordedOnly = {
      id: "recorded", displayName: "recorded", executorKind: "codex",
      computerId: "c3", placements: [],
    } as unknown as UserAgent;
    const explicitTeam = { ...team("explicit", ["active"]), computerId: "c9" } as AgentTeam;
    const inferredTeam = team("inferred", ["active"]);
    const agents = [active, draining, recordedOnly];
    const teams = [explicitTeam, inferredTeam];

    assert.equal(assignmentComputerId({ assignedAgentId: "active" }, agents, teams), "c1");
    assert.equal(assignmentComputerId({ assignedAgentId: "draining" }, agents, teams), "c2");
    assert.equal(assignmentComputerId({ assignedAgentId: "recorded" }, agents, teams), "c3");
    assert.equal(assignmentComputerId({ assignedTeamId: "explicit" }, agents, teams), "c9");
    assert.equal(assignmentComputerId({ assignedTeamId: "inferred" }, agents, teams), "c1");
    assert.equal(assignmentComputerId({}, agents, teams), undefined);
  });
});
