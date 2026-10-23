import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  awaitingInput,
  buildThreadWaitIndex,
  threadAwaitsHuman,
  threadWaitIndex,
} from "../src/lib/awaitingInput.js";
import { groupThreads } from "../src/lib/threadGroups.js";
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
    agentRuns: [{ id: "run_1", agent: "codex", status: "completed" }],
    artifacts: [],
    decisions: [],
    activeRoundId: "round",
    collaborationRounds: [{ roundId: "round", workScope: { kind: "task", taskId: "task_1" } }],
    events: [],
    ...partial,
  } as RelaySession;
}

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

describe("buildThreadWaitIndex", () => {
  it("maps a resumable wait to its session and every task to its id", () => {
    const waiting = task();
    const done = task({ id: "task_2", status: "done", awaiting: wait({ sessionId: "ses_2" }) });
    const index = buildThreadWaitIndex([waiting, done]);
    assert.equal(index.waitsBySession.get("ses_1")?.task, waiting);
    assert.equal(index.waitsBySession.has("ses_2"), false, "a finished task's wait is not resumable");
    assert.equal(index.tasksById.get("task_2"), done);
  });

  it("keeps list order: the first task naming a session wins, like the scan did", () => {
    const first = task({ id: "task_a" });
    const second = task({ id: "task_b" });
    const index = buildThreadWaitIndex([first, second]);
    assert.equal(index.waitsBySession.get("ses_1")?.task, first);
  });

  it("skips deleted tasks and waits without a session", () => {
    const index = buildThreadWaitIndex([
      task({ deletedAt: "2026-10-10T00:00:00.000Z" }),
      task({ id: "task_legacy", awaiting: wait({ sessionId: undefined }) }),
    ]);
    assert.equal(index.waitsBySession.size, 0);
    assert.equal(index.tasksById.has("task_legacy"), true);
  });
});

describe("threadWaitIndex", () => {
  it("returns an index unchanged and remembers the one built for a list", () => {
    const tasks = [task()];
    const built = threadWaitIndex(tasks);
    assert.equal(threadWaitIndex(built), built);
    assert.equal(threadWaitIndex(tasks), built, "the same list identity reuses its index");
    assert.notEqual(threadWaitIndex([task()]), built, "a new list is indexed afresh");
  });
});

describe("index and list agree", () => {
  const cases: [string, RelaySession, RelayTaskListItem[]][] = [
    ["a wait naming the thread", session(), [task()]],
    ["a legacy wait on the active round's task", session(), [task({ awaiting: wait({ sessionId: undefined }) })]],
    ["a task that moved on", session({ workOutcome: "blocked" }), [task({ status: "running", awaiting: undefined })]],
    ["a thread with no task", session({ collaborationRounds: [], workOutcome: "blocked", inputQuestion: "Proceed?" }), []],
    ["a thread nothing waits on", session(), []],
  ];
  for (const [name, thread, tasks] of cases) {
    it(`for ${name}`, () => {
      const index = buildThreadWaitIndex(tasks);
      assert.deepEqual(awaitingInput(thread, index), awaitingInput(thread, tasks));
      assert.equal(threadAwaitsHuman(thread, index), threadAwaitsHuman(thread, tasks));
    });
  }

  it("groups threads the same way from an index", () => {
    const items = [{ session: session() }, { session: session({ id: "ses_9", collaborationRounds: [] }) }];
    const tasks = [task()];
    const fromList = groupThreads(items, tasks);
    const fromIndex = groupThreads(items, buildThreadWaitIndex(tasks));
    assert.deepEqual(fromIndex.needsYou.map((item) => item.session.id), ["ses_1"]);
    assert.deepEqual(fromIndex.idle.map((item) => item.session.id), fromList.idle.map((item) => item.session.id));
  });
});
