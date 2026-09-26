import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { materializeTaskEvents, relayTaskEvent } from "../src/index.js";

describe("task team assignment events", () => {
  it("keeps an admitted execution ready until the agent starts", () => {
    const taskId = "task-stage";
    const admitted = materializeTaskEvents([
      relayTaskEvent("task.created", taskId, { title: "Wait for the daemon", description: "", priority: "normal" }),
      relayTaskEvent("task.status", taskId, { status: "assigned" }),
      relayTaskEvent("task.execution.claimed", taskId, { requestId: "request", expectedRevision: 0, revision: 1 }),
    ]);

    assert.equal(admitted.status, "assigned");
    assert.equal(admitted.workflowStage, "assigned");

    const executing = materializeTaskEvents([
      ...admitted.events,
      relayTaskEvent("task.status", taskId, { status: "running" }),
    ]);
    assert.equal(executing.workflowStage, "running");
  });

  it("replays the task execution generation after completion", () => {
    const rebuilt = materializeTaskEvents([
      relayTaskEvent("task.created", "task-owned", { title: "Owned", description: "", priority: "normal" }),
      relayTaskEvent("task.execution.claimed", "task-owned", { requestId: "first", expectedRevision: 0, revision: 1 }),
      relayTaskEvent("task.execution.claimed", "task-owned", { requestId: "second", expectedRevision: 1, revision: 2 }),
      relayTaskEvent("task.status", "task-owned", { status: "done" }),
    ]);
    assert.deepEqual(rebuilt.executionOwner, { requestId: "second", revision: 2 });
  });
  it("materializes a team-only assignment and clears a prior agent assignment", () => {
    const taskId = "task-1";

    const rebuilt = materializeTaskEvents([
      relayTaskEvent("task.created", taskId, {
        title: "Team task",
        description: "",
        priority: "normal",
      }),
      relayTaskEvent("task.assigned", taskId, { agent: "codex", agentId: "agent-1" }),
      relayTaskEvent("task.assigned", taskId, { teamId: "team-1" }),
    ]);

    assert.equal(rebuilt.assignedTeamId, "team-1");
    assert.equal(rebuilt.assignedAgent, undefined);
    assert.equal(rebuilt.assignedAgentId, undefined);
  });

  it("removes a linked session when the backend records an unlink event", () => {
    const taskId = "task-2";

    const rebuilt = materializeTaskEvents([
      relayTaskEvent("task.created", taskId, {
        title: "Session lifecycle",
        description: "",
        priority: "normal",
      }),
      relayTaskEvent("task.session_linked", taskId, { sessionId: "session-1" }),
      relayTaskEvent("task.session_unlinked", taskId, { sessionId: "session-1" }),
    ]);

    assert.deepEqual(rebuilt.linkedSessionIds, []);
  });
});

describe("blocked execution explanations", () => {
  it("replays the exact source and clears it when unblocked", () => {
    const task = materializeTaskEvents([
      relayTaskEvent("task.created", "task", { title: "Task", description: "", priority: "normal" }),
      relayTaskEvent("task.status", "task", { status: "blocked", reason: "Executor exited", attention: { code: "agent_exit_failed", source: "execution", sessionId: "actual" } }),
    ]);
    assert.equal(task.attention?.sessionId, "actual");
    assert.equal(task.attention?.summary, "Executor exited");
    assert.equal(task.attention?.evidence, "recorded");
    const unknown = materializeTaskEvents([...task.events, relayTaskEvent("task.status", "task", { status: "blocked" })]);
    assert.equal(unknown.attention?.code, "unknown");
    assert.equal(unknown.attention?.evidence, "unknown");
    assert.equal(unknown.attention?.sessionId, undefined);
    assert.notEqual(unknown.blockerReason, "Executor exited");
    const resumed = materializeTaskEvents([...task.events, relayTaskEvent("task.status", "task", { status: "assigned" })]);
    assert.equal(resumed.attention, undefined);
  });
});


it("replays an intake issue joining a project", () => {
  const task = materializeTaskEvents([
    relayTaskEvent("task.created", "intake", { title: "Triage", description: "", priority: "normal" }),
    relayTaskEvent("task.project_set", "intake", { projectId: "project" }),
    relayTaskEvent("task.assigned", "intake", { agent: "codex", agentId: "agent" }),
  ]);
  assert.equal(task.projectId, "project");
  assert.equal(task.assignedAgentId, "agent");
});
