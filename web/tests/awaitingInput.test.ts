import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { awaitingInput, readWaitingReason, taskWaitingPrompt } from "../src/lib/awaitingInput.js";
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

/** A thread whose last round was a conversation, not a task's round. */
function threadSession(partial: Partial<RelaySession> = {}): RelaySession {
  return session({ collaborationRounds: [], ...partial });
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
      threadSession({ workOutcome: "blocked", finalOutcome: "The round reported it is blocked. Which vault holds the staging key?" }),
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
    const waiting = awaitingInput(threadSession({ workOutcome: "blocked", finalOutcome: "The round reported it is blocked." }), []);
    assert.equal(waiting?.kind, "question");
    assert.equal(waiting?.text, null);
  });

  it("treats a gated round as a check and words it without internal ids", () => {
    const legacy = awaitingInput(
      threadSession({ workOutcome: "blocked", finalOutcome: "Work needs attention. Work 6fc1d579-ef85-4b54-9ceb-444985f8ea6c is not accepted: missing." }),
      [],
    );
    assert.equal(legacy?.kind, "check");
    assert.equal(legacy?.text, "A required step ended without reporting what it did.");
    assert.deepEqual(legacy?.options, []);
    const current = awaitingInput(
      threadSession({ workOutcome: "blocked", finalOutcome: "The work can't be accepted yet. A required step failed to run." }),
      [],
    );
    assert.equal(current?.text, "A required step failed to run.");
  });

  it("rewords each legacy gate reason", () => {
    assert.equal(
      readWaitingReason("Work needs attention. Required contribution a1 failed. Work b2 is not accepted: tests still red. Unresolved finding on b2: crash on empty input").text,
      "A required step failed to run. A required step is not finished: tests still red. A review found a problem that is still open: crash on empty input",
    );
    // A reason that is not a gate stop is quoted as recorded.
    assert.equal(readWaitingReason("Execution needs attention.").text, "Execution needs attention.");
  });

  it("offers the answers the agent gave", () => {
    const waiting = awaitingInput(threadSession({
      workOutcome: "blocked",
      finalOutcome: "The round reported it is blocked. Rotate staging only, or prod too?",
      inputOptions: ["Staging only", "Staging and prod", "Staging only"],
    }), []);
    assert.equal(waiting?.text, "Rotate staging only, or prod too?");
    assert.deepEqual(waiting?.options, ["Staging only", "Staging and prod"]);
  });

  for (const text of [
    "Which vault holds the key?\n1. ops-vault\n2) shared-vault",
    "Please provide these details:\n- Deployment region\n- Project name",
    "Which environment?\n" + Array.from({ length: 7 }, (_, i) => `${i + 1}. env-${i + 1}`).join("\n"),
  ]) {
    it(`preserves an unstructured list: ${text.split("\n")[0]}`, () => {
      const waiting = awaitingInput(threadSession({
        workOutcome: "blocked",
        finalOutcome: `The round reported it is blocked. ${text}`,
      }), []);
      assert.equal(waiting?.text, text);
      assert.deepEqual(waiting?.options, []);
    });
  }

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

  it("drops a task round's old question once the task is no longer waiting", () => {
    const stale = session({ workOutcome: "blocked", finalOutcome: "The round reported it is blocked. Which vault?" });
    for (const status of ["done", "review", "assigned", "running"] as const) {
      assert.equal(awaitingInput(stale, [task({ status })]), null, status);
    }
    assert.equal(awaitingInput(stale, []), null);
  });

  it("leaves a task waiting in a newer thread to that thread", () => {
    const elsewhere = task({ waitingSessionId: "ses_newer", waitingReason: "The round reported it is blocked. Which region?" });
    assert.equal(awaitingInput(session({ workOutcome: "blocked" }), [elsewhere]), null);
  });

  it("keeps the wait after a status question took over the active round", () => {
    const named = task({
      waitingSessionId: "ses_1",
      waitingRequest: { inputQuestion: "Which vault?", inputOptions: ["Ops", "Shared"] },
    });
    const afterStatus = session({
      workOutcome: "unverified",
      activeRoundId: "status-round",
      collaborationRounds: [
        { roundId: "asking-round", workScope: { kind: "task", taskId: "task_1" } },
        { roundId: "status-round", workScope: { kind: "thread" } },
      ] as RelaySession["collaborationRounds"],
    });
    const waiting = awaitingInput(afterStatus, [named]);
    assert.equal(waiting?.task?.id, "task_1");
    assert.equal(waiting?.text, "Which vault?");
    assert.deepEqual(waiting?.options, ["Ops", "Shared"]);
  });

  it("quotes the structured question and carries the gates it stood in front of", () => {
    const waiting = awaitingInput(threadSession({
      workOutcome: "blocked",
      finalOutcome: "The round reported it is blocked. Which vault? 1 participant assignment(s) failed; inspect the thread before closing the work.",
      inputQuestion: "Which vault?",
      inputNotes: ["A required step failed to run.", " "],
    }), []);
    assert.equal(waiting?.kind, "question");
    assert.equal(waiting?.text, "Which vault?");
    assert.deepEqual(waiting?.notes, ["A required step failed to run."]);
  });

  it("offers answers even when the agent gave no question text", () => {
    const waiting = awaitingInput(threadSession({
      workOutcome: "blocked",
      finalOutcome: "The round reported it is blocked.",
      inputOptions: ["Staging", "Prod"],
    }), []);
    assert.equal(waiting?.text, null);
    assert.deepEqual(waiting?.options, ["Staging", "Prod"]);
  });
});

describe("taskWaitingPrompt", () => {
  it("prefers the structured question over the recorded reason", () => {
    assert.deepEqual(
      taskWaitingPrompt({
        waitingReason: "The round reported it is blocked. Which vault? 1 participant assignment(s) failed.",
        waitingRequest: { inputQuestion: "Which vault?", inputNotes: ["A required step failed to run."] },
      }),
      { kind: "question", text: "Which vault?", notes: ["A required step failed to run."] },
    );
  });

  it("quotes a parked wait's reason", () => {
    const parked = taskWaitingPrompt({ waitingReason: "The task used its 5-round budget without reporting it was finished." });
    assert.equal(parked.kind, "check");
    assert.match(parked.text ?? "", /5-round budget/);
  });
});
