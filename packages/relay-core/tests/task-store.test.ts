import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { materializeTaskEvents, relayTaskEvent } from "../src/index.js";

describe("task team assignment events", () => {
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
