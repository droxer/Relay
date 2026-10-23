import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatRunDuration, runDurationMs, runOutcome } from "../src/lib/taskRuns.js";
import type { TaskRun, TaskStatus } from "../src/types.js";

function run(overrides: Partial<TaskRun> = {}): TaskRun {
  return {
    taskId: "occurrence-1",
    scheduledFor: "2026-06-25",
    status: "done",
    createdAt: "2026-06-25T09:00:00.000Z",
    startedAt: "2026-06-25T09:00:00.000Z",
    endedAt: "2026-06-25T09:12:00.000Z",
    failureMessage: null,
    sessionIds: ["session-1"],
    latestSessionId: "session-1",
    artifactCount: 1,
    ...overrides,
  };
}

describe("runOutcome", () => {
  it("reads done and blocked as the two settled outcomes", () => {
    assert.equal(runOutcome(run({ status: "done" })), "done");
    assert.equal(runOutcome(run({ status: "blocked" })), "failed");
  });

  it("treats a run awaiting a person as still going", () => {
    for (const status of ["running", "review", "waiting_for_human"] as TaskStatus[]) {
      assert.equal(runOutcome(run({ status })), "running");
    }
  });

  it("reads a promoted but undispatched occurrence as pending", () => {
    assert.equal(runOutcome(run({ status: "assigned" })), "pending");
    assert.equal(runOutcome(run({ status: "backlog" })), "pending");
  });
});

describe("runDurationMs", () => {
  it("measures start to end", () => {
    assert.equal(runDurationMs(run()), 12 * 60 * 1000);
  });

  it("has no duration while the run is still open", () => {
    assert.equal(runDurationMs(run({ endedAt: null })), null);
    assert.equal(runDurationMs(run({ startedAt: null })), null);
  });

  it("refuses timestamps it cannot order", () => {
    assert.equal(runDurationMs(run({ endedAt: "2026-06-25T08:00:00.000Z" })), null);
    assert.equal(runDurationMs(run({ endedAt: "not a date" })), null);
  });
});

describe("formatRunDuration", () => {
  it("keeps the column scannable across scales", () => {
    assert.equal(formatRunDuration(4_000), "4s");
    assert.equal(formatRunDuration(12 * 60 * 1000), "12m");
    assert.equal(formatRunDuration(192_000), "3m 12s");
    assert.equal(formatRunDuration(63 * 60 * 1000), "1h 03m");
  });
});
