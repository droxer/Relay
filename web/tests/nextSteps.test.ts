import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { adoptedNextStepTask, nextStepTaskInput, threadNextSteps } from "../src/lib/nextSteps.js";
import { applySessionEvent } from "../src/lib/sessionEvents.js";
import type { RelaySession, RelayTaskListItem } from "../src/types.js";

type RelayEvent = RelaySession["events"][number];

function session(partial: Partial<RelaySession> = {}): RelaySession {
  return {
    id: "ses_1",
    workspacePath: "/workspace",
    taskGoal: "Tidy the parser",
    participants: ["human", "codex"],
    status: "completed",
    phase: "completed",
    createdAt: "2026-10-25T00:00:00.000Z",
    updatedAt: "2026-10-25T00:00:00.000Z",
    agentRuns: [],
    artifacts: [],
    decisions: [],
    events: [],
    nextSteps: ["Add tests for the parser"],
    ...partial,
  } as RelaySession;
}

describe("threadNextSteps", () => {
  it("offers a finished turn's suggestions while the thread is free", () => {
    assert.deepEqual(threadNextSteps(session(), { busy: false }), ["Add tests for the parser"]);
  });

  it("offers nothing while anything else claims the thread", () => {
    assert.deepEqual(threadNextSteps(session(), { busy: true }), []);
    assert.deepEqual(threadNextSteps(session({ status: "running" }), { busy: false }), []);
    assert.deepEqual(threadNextSteps(undefined, { busy: false }), []);
  });

  it("offers nothing once a message is already waiting to start", () => {
    const sent = { id: "e1", type: "user.message", sessionId: "ses_1", timestamp: "t", text: "Ship it" } as RelayEvent;
    assert.deepEqual(threadNextSteps(session({ events: [sent] }), { busy: false }), []);
  });

  it("bounds agent-written text rather than trusting it", () => {
    const steps = ["  Add   tests ", "Add tests", "x".repeat(400), "Ship it", "Fourth"];
    assert.deepEqual(threadNextSteps(session({ nextSteps: steps }), { busy: false }), ["Add tests", "x".repeat(160), "Ship it"]);
  });
});

describe("next steps in the session reducer", () => {
  it("are set by a completion and retired by the next run", () => {
    const completed = applySessionEvent(session({ nextSteps: undefined, status: "running" }), {
      id: "e1", type: "session.completed", sessionId: "ses_1", timestamp: "t1", outcome: "ok", nextSteps: ["Ship it"],
    } as RelayEvent);
    assert.deepEqual(completed.nextSteps, ["Ship it"]);
    const started = applySessionEvent(completed, {
      id: "e2", type: "agent.started", sessionId: "ses_1", timestamp: "t2", runId: "run_2", agent: "codex",
    } as RelayEvent);
    assert.equal(started.nextSteps, undefined);
  });
});

describe("adopting a next step as a task", () => {
  const task = (partial: Partial<RelayTaskListItem>) => ({ id: "t1", title: "Ship it", isRoutine: false, ...partial }) as RelayTaskListItem;

  it("files a project thread's suggestion in that project, unassigned", () => {
    assert.deepEqual(nextStepTaskInput("Ship it", "proj_1"), { title: "Ship it", projectId: "proj_1" });
  });

  it("files a suggestion outside a project as an issue with no project", () => {
    assert.deepEqual(nextStepTaskInput("Ship it", null), { title: "Ship it" });
  });

  it("finds the task a suggestion already became in the same scope only", () => {
    const inProject = task({ id: "t1", projectId: "proj_1" });
    const intake = task({ id: "t2" });
    assert.equal(adoptedNextStepTask("Ship it", [intake, inProject], "proj_1")?.id, "t1");
    assert.equal(adoptedNextStepTask("Ship it", [inProject, intake], null)?.id, "t2");
    assert.equal(adoptedNextStepTask("Ship it", [inProject], "proj_2"), undefined);
  });

  it("ignores deleted tasks, automations, and other titles", () => {
    const tasks = [
      task({ deletedAt: "2026-11-01T00:00:00.000Z" }),
      task({ id: "t2", isRoutine: true }),
      task({ id: "t3", title: "Ship it later" }),
    ];
    assert.equal(adoptedNextStepTask("Ship it", tasks, null), undefined);
  });
});
