import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { threadNextSteps } from "../src/lib/nextSteps.js";
import { applySessionEvent } from "../src/lib/sessionEvents.js";
import type { RelaySession } from "../src/types.js";

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
