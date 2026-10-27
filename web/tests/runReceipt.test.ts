import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TFunction } from "i18next";

import { projectMessages, type DerivedMessage } from "../src/lib/projectMessages.js";
import { runReceipt } from "../src/lib/runReceipt.js";
import type { RelaySession } from "../src/types.js";

const t = ((key: string) => key) as unknown as TFunction;
const started = "2026-10-23T10:00:00.000Z";
const finished = "2026-10-23T10:03:12.000Z";

function session(events: RelaySession["events"]): RelaySession {
  return {
    id: "ses_1",
    workspacePath: "/workspace",
    taskGoal: "Ship pricing copy",
    participants: ["human", "claude"],
    status: "completed",
    phase: "completed",
    createdAt: started,
    updatedAt: finished,
    agentRuns: [],
    artifacts: [],
    decisions: [],
    collaborationRounds: [],
    events,
  } as RelaySession;
}

function turn(completed: Record<string, unknown> | null, extra: RelaySession["events"] = []): Extract<DerivedMessage, { kind: "agent" }> {
  const events = [
    { id: "ev_start", type: "agent.started", sessionId: "ses_1", timestamp: started, runId: "run_1", agent: "claude" },
    ...extra,
    ...(completed
      ? [{ id: "ev_done", type: "agent.completed", sessionId: "ses_1", timestamp: finished, runId: "run_1", agent: "claude", exitCode: 0, status: "completed", ...completed }]
      : []),
  ] as RelaySession["events"];
  const message = projectMessages(session(events), t).find((entry) => entry.kind === "agent");
  assert.ok(message && message.kind === "agent");
  return message;
}

describe("run receipt", () => {
  it("has no receipt while the turn is still streaming", () => {
    assert.equal(runReceipt(turn(null)), null);
  });

  it("records the outcome, duration, and usage of a finished turn", () => {
    const receipt = runReceipt(turn({ tokenUsage: { input: 9000, output: 4000, cache: 89200, cacheRead: 88000, cacheWrite: 1200, total: 102200 } }));
    assert.deepEqual(receipt, {
      outcome: "completed",
      exitCode: 0,
      durationMs: 192_000,
      tokens: { fresh: 14_200 },
    });
  });

  it("says a failure and its exit code, and that usage went unreported", () => {
    const receipt = runReceipt(turn({ status: "failed", exitCode: 1 }));
    assert.equal(receipt?.outcome, "failed");
    assert.equal(receipt?.exitCode, 1);
    assert.equal(receipt?.tokens, null);
  });
});
