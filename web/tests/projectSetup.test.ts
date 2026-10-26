import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  effectiveLead,
  provisionalProjectName,
  setupApplyInput,
  setupDraftFromProposal,
  keptMemberIds,
  setupNeedsAttention,
  setupTaskAfterTitles,
  setupTasksApplyInput,
} from "../src/lib/projectSetup.ts";
import type { ProjectRecord, ProjectSetupProposal } from "../src/types.ts";

const project = {
  id: "p",
  version: 3,
  name: "Launch our marketing site",
  description: "Launch our marketing site",
  members: [],
  leadAgentId: null,
} as unknown as ProjectRecord;

const proposal: ProjectSetupProposal = {
  name: "Spring launch",
  goal: "Ship by March 14",
  context: "Use Next.js.",
  leadAgentId: "gone",
  members: [
    { agentId: "gone", role: "planner", responsibilities: "Plan", issue: "agent_not_found" },
    { agentId: "ada", role: "planner", responsibilities: "Own the plan" },
    { agentId: "bo", role: "implementer", responsibilities: "Build pages", instructions: "Mobile first" },
  ],
  tasks: [
    { key: "sitemap", title: "Draft the sitemap", assignedAgentId: "ada" },
    { title: "Hire a designer", assignedAgentId: "gone", after: ["sitemap"] },
  ],
};

describe("provisionalProjectName", () => {
  it("uses the intent's first line without trailing punctuation", () => {
    assert.equal(provisionalProjectName("\n  Launch the site.\nWith pricing", "New project"), "Launch the site");
  });
  it("clips long intents on a word boundary", () => {
    const name = provisionalProjectName("Build a customer support knowledge base that answers billing questions in three languages", "x");
    assert.ok(name.length <= 61);
    assert.ok(name.endsWith("…"));
    assert.ok(!name.slice(0, -1).endsWith(" "));
  });
  it("falls back when the intent is blank", () => {
    assert.equal(provisionalProjectName("   ", "New project"), "New project");
  });
});

describe("setup drafts", () => {
  it("leaves blocked members unchecked and moves the lead to a kept member", () => {
    const draft = setupDraftFromProposal(proposal, project);
    assert.deepEqual(draft.members.map((m) => m.include), [false, true, true]);
    assert.equal(draft.leadAgentId, "ada");
    assert.equal(effectiveLead(draft.members.map((m) => ({ ...m, include: false })), "ada"), null);
  });

  it("applies the brief, kept roster, and the setup closing in one patch", () => {
    const draft = setupDraftFromProposal(proposal, project);
    const input = setupApplyInput(project, draft);
    assert.equal(input.expectedVersion, 3);
    assert.equal(input.name, "Spring launch");
    assert.equal(input.goal, "Ship by March 14");
    assert.equal(input.description, undefined, "an unchanged brief is not resent");
    assert.equal(input.setupResolution, "applied");
    assert.deepEqual(input.members?.map((m) => m.agentId), ["ada", "bo"]);
    assert.equal(input.members?.[1].instructions, "Mobile first");
    assert.equal(input.leadAgentId, "ada");
  });

  it("leaves the roster alone when the owner keeps no members", () => {
    const draft = setupDraftFromProposal(proposal, project);
    const input = setupApplyInput(project, { ...draft, members: draft.members.map((m) => ({ ...m, include: false })) });
    assert.equal(input.members, undefined);
    assert.equal(input.leadAgentId, undefined);
  });

  it("applies kept tasks by key and drops assignees who are not kept members", () => {
    const draft = setupDraftFromProposal(proposal, project);
    assert.deepEqual(draft.tasks.map((task) => task.key), ["sitemap", "task-2"], "an unkeyed task is keyed by position");
    assert.deepEqual(setupTasksApplyInput("setup_1", draft, keptMemberIds(draft), true), {
      draftId: "setup_1",
      taskKeys: ["sitemap", "task-2"],
      assignedAgentIds: { sitemap: "ada", "task-2": null },
      queue: true,
    });
  });

  it("names a task's kept prerequisites and drops the ones left out", () => {
    const draft = setupDraftFromProposal(proposal, project);
    const [sitemap, designer] = draft.tasks;
    assert.deepEqual(setupTaskAfterTitles(designer, draft.tasks), ["Draft the sitemap"]);
    const without = [{ ...sitemap, include: false }, designer];
    assert.deepEqual(setupTaskAfterTitles(designer, without), []);
    const input = setupTasksApplyInput("setup_1", { ...draft, tasks: without }, new Set(), false);
    assert.deepEqual(input.taskKeys, ["task-2"]);
  });

  it("shows only open setups", () => {
    assert.equal(setupNeedsAttention(undefined), false);
    assert.equal(setupNeedsAttention({ state: "applied" } as never), false);
    assert.equal(setupNeedsAttention({ state: "failed" } as never), true);
  });
});
