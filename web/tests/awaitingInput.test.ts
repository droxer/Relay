import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { awaitingInput } from "../src/lib/awaitingInput.js";
import type { RelaySession, RelayTaskListItem } from "../src/types.js";

function session(partial: Partial<RelaySession> = {}): RelaySession {
  return {
    id: "ses_1",
    workspacePath: "/workspace",
    taskGoal: "Rotate keys",
    participants: ["human", "codex"],
    status: "completed",
    phase: "completed",
    createdAt: "2026-10-10T00:00:00.000Z",
    updatedAt: "2026-10-10T00:00:00.000Z",
    agentRuns: [{ id: "run_1", agent: "codex", logicalAgentId: "agt_reviewer", status: "completed" }],
    artifacts: [],
    decisions: [],
    activeRoundId: "asking-round",
    collaborationRounds: [{ roundId: "asking-round", workScope: { kind: "task", taskId: "task_1" } }],
    events: [],
    ...partial,
  } as RelaySession;
}

function task(partial: Partial<RelayTaskListItem> = {}): RelayTaskListItem {
  return {
    id: "task_1",
    number: 12,
    title: "Rotate keys",
    status: "waiting_for_human",
    isRoutine: false,
    linkedSessionIds: ["ses_1"],
    ...partial,
  } as RelayTaskListItem;
}

describe("awaitingInput", () => {
  it("quotes the agent's question without the system preamble", () => {
    const waiting = awaitingInput(
      session({ workOutcome: "blocked", finalOutcome: "The round reported it is blocked. Which vault holds the staging key?" }),
      [],
    );
    assert.deepEqual(waiting && { kind: waiting.kind, text: waiting.text }, {
      kind: "question",
      text: "Which vault holds the staging key?",
    });
  });

  it("prefers the waiting task's recorded reason and names the task", () => {
    const linked = task({ waitingReason: "The round reported it is blocked. Use staging or prod?" });
    const waiting = awaitingInput(session({ finalOutcome: "stale" }), [linked]);
    assert.equal(waiting?.text, "Use staging or prod?");
    assert.equal(waiting?.task?.id, "task_1");
    assert.equal(waiting?.run?.logicalAgentId, "agt_reviewer");
  });

  it("says a blocked round gave no question rather than inventing one", () => {
    const waiting = awaitingInput(session({ workOutcome: "blocked", finalOutcome: "The round reported it is blocked." }), []);
    assert.equal(waiting?.kind, "question");
    assert.equal(waiting?.text, null);
  });

  it("treats a gated round as a check, keeping the recorded reason", () => {
    const waiting = awaitingInput(
      session({ workOutcome: "blocked", finalOutcome: "Work needs attention. Work a1 is not accepted: missing." }),
      [],
    );
    assert.equal(waiting?.kind, "check");
    assert.equal(waiting?.text, "Work needs attention. Work a1 is not accepted: missing.");
  });

  it("stays quiet while running, after a failure, finished work, or a pending feedback decision", () => {
    assert.equal(awaitingInput(session({ status: "running", workOutcome: "blocked" }), [task()]), null);
    assert.equal(awaitingInput(session({ status: "failed", workOutcome: "blocked" }), []), null);
    assert.equal(awaitingInput(session({ workOutcome: "reported_done" }), [task({ status: "done" })]), null);
    assert.equal(
      awaitingInput(session({ status: "waiting_for_human", pendingDecision: "feedback" }), [task()]),
      null,
    );
    assert.equal(awaitingInput(undefined, [task()]), null);
  });

  it("ignores a waiting task outside the active round's scope", () => {
    assert.equal(awaitingInput(session(), [task({ id: "other-task" })]), null);
  });

  it("does not promise task resumption for a legacy linked thread", () => {
    assert.equal(awaitingInput(session({ collaborationRounds: [] }), [task()]), null);
  });

  it("ignores an old task round when the active round is a conversation", () => {
    const conversation = session({
      activeRoundId: "chat-round",
      collaborationRounds: [
        { roundId: "asking-round", workScope: { kind: "task", taskId: "task_1" } },
        { roundId: "chat-round", workScope: { kind: "thread" } },
      ] as RelaySession["collaborationRounds"],
    });
    assert.equal(awaitingInput(conversation, [task()]), null);
  });

  it("keeps a blocked thread's own question without attaching an unrelated task", () => {
    const waiting = awaitingInput(session({
      collaborationRounds: [],
      workOutcome: "blocked",
      finalOutcome: "The round reported it is blocked. Which environment?",
    }), [task({ waitingReason: "A different task question" })]);
    assert.equal(waiting?.text, "Which environment?");
    assert.equal(waiting?.task, undefined);
  });

  it("selects the active scope's task among several linked tasks", () => {
    const unrelated = task({ id: "other-task", waitingReason: "Wrong question" });
    const scoped = task({ waitingReason: "The round reported it is blocked. Which vault?" });
    const waiting = awaitingInput(session(), [unrelated, scoped]);
    assert.equal(waiting?.task?.id, scoped.id);
    assert.equal(waiting?.text, "Which vault?");
  });

  it("ignores deleted and routine tasks even when the round names them", () => {
    assert.equal(awaitingInput(session(), [task({ deletedAt: "2026-10-10T00:00:00.000Z" })]), null);
    assert.equal(awaitingInput(session(), [task({ isRoutine: true })]), null);
  });
});
