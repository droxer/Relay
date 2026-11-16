import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  draftFromTeam,
  emptyWorkflowStep,
  moveWorkflowStep,
  newWorkflowStepId,
  projectWorkflowTeams,
  validateWorkflowDraft,
  withStepKind,
  workflowDraftChanged,
  workflowDraftValid,
  workflowTeamInput,
  type WorkflowStepDraft,
  type WorkflowTeamDraft,
} from "../src/lib/workflowTeamDraft.js";
import type { AgentTeam } from "../src/types.js";

const project = { id: "project-1", computerId: "computer-1", leadAgentId: "lead" };

function step(id: string, agentId: string, patch: Partial<WorkflowStepDraft> = {}): WorkflowStepDraft {
  return {
    id, name: id, agentId, instructions: `do ${id}`,
    expectedOutputs: `${id} output`, acceptanceCriteria: `${id} ok`,
    kind: "work", requiresApproval: false, ...patch,
  };
}

const draft: WorkflowTeamDraft = {
  name: " Ship it ",
  steps: [
    step("design", "designer"),
    step("build", "builder"),
    step("verify", "designer"),
    step("deploy", "lead", { kind: "deployment", requiresApproval: true }),
  ],
};

describe("workflowTeamInput", () => {
  it("sends saved order, repeated assignees, and no legacy policy fields", () => {
    const input = workflowTeamInput(draft, project);
    assert.deepEqual(input.workflowSteps?.map((item) => [item.id, item.agentId]), [
      ["design", "designer"], ["build", "builder"], ["verify", "designer"], ["deploy", "lead"],
    ]);
    assert.deepEqual(input.memberAgentIds, ["designer", "builder", "lead"]);
    assert.equal(input.leadAgentId, "lead");
    assert.equal(input.projectId, "project-1");
    assert.equal(input.computerId, "computer-1");
    assert.equal(input.name, "Ship it");
    assert.equal("collaborationStyle" in input, false);
    assert.equal("humanApproval" in input, false);
    assert.equal(input.workflowSteps?.[3].requiresApproval, true);
  });

  it("splits outputs and criteria by line and drops blanks", () => {
    const input = workflowTeamInput({
      name: "x",
      steps: [step("a", "lead", { expectedOutputs: " one \n\n two ", acceptanceCriteria: "ok\n" })],
    }, project);
    assert.deepEqual(input.workflowSteps?.[0].expectedOutputs, ["one", "two"]);
    assert.deepEqual(input.workflowSteps?.[0].acceptanceCriteria, ["ok"]);
  });

  it("leads with the first step's agent when the project lead owns no step", () => {
    const input = workflowTeamInput({ name: "x", steps: [step("a", "builder")] }, project);
    assert.equal(input.leadAgentId, "builder");
  });
});

describe("workflow draft editing", () => {
  it("defaults deployment steps to an approval gate and keeps an explicit choice", () => {
    assert.equal(emptyWorkflowStep([], "", "deployment").requiresApproval, true);
    assert.equal(emptyWorkflowStep([]).requiresApproval, false);
    const work = step("a", "lead");
    assert.equal(withStepKind(work, "deployment").requiresApproval, true);
    const explicit = { ...withStepKind(work, "deployment"), requiresApproval: false };
    assert.equal(withStepKind(explicit, "deployment").requiresApproval, false);
  });

  it("allocates step ids that do not collide with existing ones", () => {
    const tokens = ["a", "b"];
    assert.equal(newWorkflowStepId([{ id: "step-a" }], () => tokens.shift()!), "step-b");
    assert.match(emptyWorkflowStep([]).id, /^step-[a-z0-9]+$/);
  });

  it("moves steps without losing ids, and ignores out-of-range moves", () => {
    const moved = moveWorkflowStep(draft.steps, 3, 0);
    assert.deepEqual(moved.map((item) => item.id), ["deploy", "design", "build", "verify"]);
    assert.deepEqual(moveWorkflowStep(draft.steps, 0, -1).map((item) => item.id), draft.steps.map((item) => item.id));
  });

  it("round-trips a saved team and only reports real changes", () => {
    const team = { name: "Ship it", workflowSteps: workflowTeamInput(draft, project).workflowSteps } as AgentTeam;
    const saved = draftFromTeam(team);
    assert.equal(workflowDraftChanged(saved, saved), false);
    assert.equal(workflowDraftChanged({ ...saved, name: "Ship it " }, saved), false);
    assert.equal(workflowDraftChanged({ ...saved, steps: moveWorkflowStep(saved.steps, 0, 1) }, saved), true);
  });
});

describe("validateWorkflowDraft", () => {
  it("accepts a complete draft of project agents", () => {
    assert.ok(workflowDraftValid(validateWorkflowDraft(draft, ["designer", "builder", "lead"])));
  });

  it("names each missing field and non-member agent per step", () => {
    const errors = validateWorkflowDraft({
      name: " ",
      steps: [step("a", "stranger", { name: "", instructions: " ", expectedOutputs: "\n" })],
    }, ["lead"]);
    assert.equal(errors.name, "required");
    assert.deepEqual(errors.fields.a, {
      name: "required", agentId: "not_member", instructions: "required", expectedOutputs: "required",
    });
    assert.equal(workflowDraftValid(errors), false);
  });

  it("requires at least one step", () => {
    assert.equal(validateWorkflowDraft({ name: "x", steps: [] }, []).steps, "required");
  });
});

describe("projectWorkflowTeams", () => {
  it("lists only this project's live workflow teams", () => {
    const teams = [
      { id: "1", projectId: "project-1", workflowSteps: [{}] },
      { id: "2", projectId: "project-2", workflowSteps: [{}] },
      { id: "3" },
      { id: "4", projectId: "project-1", workflowSteps: [{}], deletedAt: "x" },
    ] as AgentTeam[];
    assert.deepEqual(projectWorkflowTeams(teams, "project-1").map((team) => team.id), ["1"]);
  });
});
