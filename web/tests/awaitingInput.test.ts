import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { awaitingInput, taskWaitingPrompt, taskWaitingThreadId, threadAwaitsHuman } from "../src/lib/awaitingInput.js";
import type { RelaySession, RelayTaskListItem } from "../src/types.js";

type Awaiting = NonNullable<RelayTaskListItem["awaiting"]>;

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

/** The wait as the API projects it (`task_awaiting`). */
function wait(partial: Partial<Awaiting> = {}): Awaiting {
  return {
    questionId: "q_run_1",
    kind: "question",
    text: "Which vault?",
    options: [],
    notes: [],
    sessionId: "ses_1",
    resumable: true,
    ...partial,
  };
}

function task(partial: Partial<RelayTaskListItem> = {}): RelayTaskListItem {
  return {
    id: "task_1",
    number: 12,
    title: "Rotate keys",
    status: "waiting_for_human",
    isRoutine: false,
    linkedSessionIds: ["ses_1"],
    awaiting: wait(),
    ...partial,
  } as RelayTaskListItem;
}

describe("awaitingInput — a task's wait", () => {
  it("renders the projected wait, names the task, and carries its question id", () => {
    const waiting = awaitingInput(session({ finalOutcome: "stale" }), [
      task({ awaiting: wait({ options: ["Ops", "Shared"], notes: ["A required step failed to run."] }) }),
    ]);
    assert.deepEqual(
      waiting && { kind: waiting.kind, text: waiting.text, options: waiting.options, notes: waiting.notes, questionId: waiting.questionId },
      { kind: "question", text: "Which vault?", options: ["Ops", "Shared"], notes: ["A required step failed to run."], questionId: "q_run_1" },
    );
    assert.equal(waiting?.task?.id, "task_1");
    assert.equal(waiting?.run?.logicalAgentId, "agt_reviewer");
  });

  it("renders gate checks and spent budgets as their own kinds", () => {
    const check = awaitingInput(session(), [task({ awaiting: wait({ kind: "check", text: "A required step failed to run." }) })]);
    assert.equal(check?.kind, "check");
    assert.equal(check?.text, "A required step failed to run.");
    const budget = awaitingInput(session(), [task({ awaiting: wait({ kind: "budget", text: "The task used its 5-round budget." }) })]);
    assert.equal(budget?.kind, "budget");
  });

  it("keeps the wait after a status question took over the active round", () => {
    const afterStatus = session({
      workOutcome: "unverified",
      activeRoundId: "status-round",
      collaborationRounds: [
        { roundId: "asking-round", workScope: { kind: "task", taskId: "task_1" } },
        { roundId: "status-round", workScope: { kind: "thread" } },
      ] as RelaySession["collaborationRounds"],
    });
    const waiting = awaitingInput(afterStatus, [task()]);
    assert.equal(waiting?.task?.id, "task_1");
    assert.equal(waiting?.text, "Which vault?");
  });

  it("leaves a task waiting in a newer thread to that thread", () => {
    const elsewhere = task({ awaiting: wait({ sessionId: "ses_newer" }) });
    assert.equal(awaitingInput(session({ workOutcome: "blocked" }), [elsewhere]), null);
  });

  it("falls back to the active round's task for a wait that never named its thread", () => {
    const legacy = task({ awaiting: wait({ sessionId: null, questionId: null }) });
    const waiting = awaitingInput(session(), [legacy]);
    assert.equal(waiting?.task?.id, "task_1");
    assert.equal(waiting?.questionId, undefined);
    assert.equal(awaitingInput(session({ collaborationRounds: [] }), [legacy]), null);
  });

  it("selects the task waiting in this thread among several", () => {
    const unrelated = task({ id: "other-task", awaiting: wait({ sessionId: "ses_other", text: "Wrong question" }) });
    const waiting = awaitingInput(session(), [unrelated, task()]);
    assert.equal(waiting?.task?.id, "task_1");
    assert.equal(waiting?.text, "Which vault?");
  });

  it("ignores deleted tasks and waits the projection marks unresumable", () => {
    assert.equal(awaitingInput(session(), [task({ deletedAt: "2026-10-10T00:00:00.000Z" })]), null);
    assert.equal(awaitingInput(session(), [task({ isRoutine: true, awaiting: wait({ resumable: false }) })]), null);
  });

  it("drops a task round's old question once the task is no longer waiting", () => {
    const stale = session({ workOutcome: "blocked", finalOutcome: "The round reported it is blocked. Which vault?" });
    for (const status of ["done", "review", "assigned", "running"] as const) {
      assert.equal(awaitingInput(stale, [task({ status, awaiting: null })]), null, status);
    }
  });

  it("stays quiet while running, after a failure, finished work, or a pending feedback decision", () => {
    assert.equal(awaitingInput(session({ status: "running", workOutcome: "blocked" }), [task()]), null);
    assert.equal(awaitingInput(session({ status: "failed", workOutcome: "blocked" }), []), null);
    assert.equal(awaitingInput(session({ workOutcome: "reported_done" }), [task({ status: "done", awaiting: null })]), null);
    assert.equal(
      awaitingInput(session({ status: "waiting_for_human", pendingDecision: "feedback" }), [task()]),
      null,
    );
    assert.equal(awaitingInput(undefined, [task()]), null);
  });
});

describe("awaitingInput — a thread with no task", () => {
  it("quotes the agent's question without the system preamble", () => {
    const waiting = awaitingInput(
      threadSession({ workOutcome: "blocked", finalOutcome: "The round reported it is blocked. Which vault holds the staging key?" }),
      [],
    );
    assert.deepEqual(waiting && { kind: waiting.kind, text: waiting.text, questionId: waiting.questionId }, {
      kind: "question",
      text: "Which vault holds the staging key?",
      questionId: undefined,
    });
  });

  it("says a blocked round gave no question rather than inventing one", () => {
    const waiting = awaitingInput(threadSession({ workOutcome: "blocked", finalOutcome: "The round reported it is blocked." }), []);
    assert.equal(waiting?.kind, "question");
    assert.equal(waiting?.text, null);
  });

  it("treats a gated round as a check without repeating the gate preamble", () => {
    const current = awaitingInput(
      threadSession({ workOutcome: "blocked", finalOutcome: "The work can't be accepted yet. A required step failed to run." }),
      [],
    );
    assert.equal(current?.kind, "check");
    assert.equal(current?.text, "A required step failed to run.");
    assert.deepEqual(current?.options, []);
  });

  it("offers the answers the agent gave, distinct and capped", () => {
    const waiting = awaitingInput(threadSession({
      workOutcome: "blocked",
      finalOutcome: "The round reported it is blocked. Rotate staging only, or prod too?",
      inputOptions: ["Staging only", "Staging and prod", "Staging only"],
    }), []);
    assert.equal(waiting?.text, "Rotate staging only, or prod too?");
    assert.deepEqual(waiting?.options, ["Staging only", "Staging and prod"]);
    const long = awaitingInput(threadSession({ workOutcome: "blocked", inputOptions: ["x".repeat(250), "Short"] }), []);
    assert.deepEqual(long?.options, ["x".repeat(200), "Short"]);
  });

  for (const text of [
    "Which vault holds the key?\n1. ops-vault\n2) shared-vault",
    "Please provide these details:\n- Deployment region\n- Project name",
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

  it("quotes the structured question and carries the gates it stood in front of", () => {
    const waiting = awaitingInput(threadSession({
      workOutcome: "blocked",
      finalOutcome: "The round reported it is blocked. Which vault? 1 participant assignment(s) failed.",
      inputQuestion: "Which vault?",
      inputNotes: ["A required step failed to run.", " "],
    }), []);
    assert.equal(waiting?.text, "Which vault?");
    assert.deepEqual(waiting?.notes, ["A required step failed to run."]);
  });

  it("keeps a blocked thread's own question without attaching an unrelated task", () => {
    const waiting = awaitingInput(threadSession({
      workOutcome: "blocked",
      finalOutcome: "The round reported it is blocked. Which environment?",
    }), [task({ awaiting: wait({ sessionId: "ses_other" }) })]);
    assert.equal(waiting?.text, "Which environment?");
    assert.equal(waiting?.task, undefined);
  });

  it("falls back to the thread's own question while its task is not in the list", () => {
    // Not loaded yet, or not the viewer's: nothing says the task moved on.
    const waiting = awaitingInput(session({
      workOutcome: "blocked",
      inputQuestion: "Which vault?",
      inputOptions: ["Ops", "Shared"],
    }), [task({ id: "other-task", status: "done", awaiting: null })]);
    assert.equal(waiting?.text, "Which vault?");
    assert.deepEqual(waiting?.options, ["Ops", "Shared"]);
    assert.equal(waiting?.task, undefined);
    assert.equal(awaitingInput(session({ workOutcome: "reported_done" }), []), null);
  });
});

describe("threadAwaitsHuman", () => {
  const blocked = (partial: Partial<RelaySession> = {}) => session({ workOutcome: "blocked", ...partial });

  it("agrees with the prompt when the scoped task is known to have moved on", () => {
    for (const status of ["done", "running", "assigned"] as const) {
      assert.equal(threadAwaitsHuman(blocked(), [task({ status, awaiting: null })]), false, status);
    }
    assert.equal(threadAwaitsHuman(blocked(), [task({ awaiting: wait({ sessionId: "ses_newer" }) })]), false);
  });

  it("trusts the thread's own record while its task is not in the list", () => {
    assert.equal(threadAwaitsHuman(blocked(), []), true);
    assert.equal(threadAwaitsHuman(session(), []), false);
  });

  it("counts a thread a waiting task names, whatever its last outcome", () => {
    const afterStatus = session({
      workOutcome: "unverified",
      activeRoundId: "status-round",
      collaborationRounds: [{ roundId: "status-round", workScope: { kind: "thread" } }] as RelaySession["collaborationRounds"],
    });
    assert.equal(threadAwaitsHuman(afterStatus, [task()]), true);
    assert.equal(threadAwaitsHuman(afterStatus, [task({ isRoutine: true, awaiting: wait({ resumable: false }) })]), false);
    assert.equal(threadAwaitsHuman(afterStatus, [task({ deletedAt: "2026-10-10T00:00:00.000Z" })]), false);
  });

  it("keeps a pending decision and ignores live or failed threads", () => {
    assert.equal(threadAwaitsHuman(session({ status: "waiting_for_human" }), []), true);
    assert.equal(threadAwaitsHuman(session({ status: "running" }), [task()]), false);
    assert.equal(threadAwaitsHuman(blocked({ status: "failed" }), []), false);
  });
});

describe("taskWaitingThreadId", () => {
  it("names the thread a waiting task waits in, not its newest link", () => {
    assert.equal(taskWaitingThreadId(task({ linkedSessionIds: ["ses_1", "ses_2"] })), "ses_1");
  });

  it("names nothing once the task is not waiting, or never said where", () => {
    assert.equal(taskWaitingThreadId(task({ status: "running", awaiting: null })), undefined);
    assert.equal(taskWaitingThreadId(task({ awaiting: wait({ sessionId: null }) })), undefined);
  });
});

describe("taskWaitingPrompt", () => {
  it("quotes the projected wait", () => {
    assert.deepEqual(
      taskWaitingPrompt(task({ awaiting: wait({ notes: ["A required step failed to run."] }) })),
      { kind: "question", text: "Which vault?", notes: ["A required step failed to run."] },
    );
  });

  it("says nothing for a task that is not waiting", () => {
    assert.equal(taskWaitingPrompt(task({ status: "running", awaiting: null })), null);
  });
});
