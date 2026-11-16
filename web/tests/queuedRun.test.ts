import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { nextQueueGraceEnd, queuedRun, queueWaitLabel, QUEUE_GRACE_MS, shownExecutionPhase } from "../src/lib/queuedRun.js";
import type { RelaySession } from "../src/types.js";

const NOW = Date.parse("2026-11-08T12:00:00.000Z");

function session(execution: Partial<NonNullable<RelaySession["execution"]>> | undefined): Pick<RelaySession, "execution"> {
  return { execution: execution as RelaySession["execution"] };
}

describe("queuedRun", () => {
  it("is null unless the run is queued", () => {
    assert.equal(queuedRun(session(undefined)), null);
    assert.equal(queuedRun(session({ phase: "running" })), null);
    assert.equal(queuedRun(session({ phase: "terminal" })), null);
  });

  it("waits for a slot on a computer that is online or not yet known", () => {
    assert.deepEqual(queuedRun(session({ phase: "queued", computerOnline: true, queuedAt: "2026-11-08T11:58:00.000Z" })),
      { cause: "slot", queuedAt: "2026-11-08T11:58:00.000Z" });
    assert.deepEqual(queuedRun(session({ phase: "queued", computerOnline: null })), { cause: "slot", queuedAt: null });
  });

  it("waits for the computer itself once it is known to be offline", () => {
    assert.equal(queuedRun(session({ phase: "queued", computerOnline: false }))?.cause, "offline");
    // The rail also knows a pinned computer dropped away.
    assert.equal(queuedRun(session({ phase: "queued", computerOnline: null }), { nodeOffline: true })?.cause, "offline");
  });
});

describe("queue grace", () => {
  const admittedAt = "2026-11-08T11:59:55.000Z";
  const admitted = Date.parse(admittedAt);

  it("shows a run a live computer has not yet taken as running until its grace ends", () => {
    const run = session({ phase: "queued", computerOnline: true, queuedAt: admittedAt });
    assert.equal(queuedRun(run, { now: admitted + QUEUE_GRACE_MS - 1 }), null);
    assert.equal(shownExecutionPhase(run, { now: admitted + 2_000 }), "running");
    assert.deepEqual(queuedRun(run, { now: admitted + QUEUE_GRACE_MS }), { cause: "slot", queuedAt: admittedAt });
    assert.equal(shownExecutionPhase(run, { now: admitted + QUEUE_GRACE_MS }), "queued");
  });

  it("treats a server clock a little ahead of the reader as inside the grace", () => {
    const run = session({ phase: "queued", computerOnline: null, queuedAt: admittedAt });
    assert.equal(queuedRun(run, { now: admitted - 2_000 }), null);
  });

  it("gives no grace to a run waiting on an offline computer", () => {
    assert.equal(queuedRun(session({ phase: "queued", computerOnline: false, queuedAt: admittedAt }), { now: admitted + 1_000 })?.cause, "offline");
    assert.equal(queuedRun(session({ phase: "queued", computerOnline: true, queuedAt: admittedAt }), { now: admitted + 1_000, nodeOffline: true })?.cause, "offline");
  });

  it("gives no grace without an admission time or a clock", () => {
    assert.equal(queuedRun(session({ phase: "queued", computerOnline: true }), { now: NOW })?.cause, "slot");
    assert.equal(queuedRun(session({ phase: "queued", computerOnline: true, queuedAt: admittedAt }))?.cause, "slot");
  });

  it("leaves every other phase as the backend says", () => {
    assert.equal(shownExecutionPhase(session({ phase: "stopping" }), { now: NOW }), "stopping");
    assert.equal(shownExecutionPhase(session(undefined), { now: NOW }), undefined);
  });

  it("names the earliest grace still ahead, for the clock to wake on", () => {
    const sessions = [
      session({ phase: "queued", queuedAt: "2026-11-08T11:59:58.000Z" }),
      session({ phase: "queued", queuedAt: admittedAt }),
      session({ phase: "queued", queuedAt: "2026-11-08T11:00:00.000Z" }),
      session({ phase: "running", queuedAt: admittedAt }),
    ];
    assert.equal(nextQueueGraceEnd(sessions, NOW), admitted + QUEUE_GRACE_MS);
    assert.equal(nextQueueGraceEnd([sessions[2]], NOW), null);
  });
});

describe("queueWaitLabel", () => {
  it("counts whole minutes on the rail and says nothing in the first one", () => {
    assert.equal(queueWaitLabel("2026-11-08T11:59:30.000Z", NOW, "minute"), "");
    assert.equal(queueWaitLabel("2026-11-08T11:56:50.000Z", NOW, "minute"), "3m");
    assert.equal(queueWaitLabel("2026-11-08T09:30:00.000Z", NOW, "minute"), "2h 30m");
  });

  it("counts seconds where the panel ticks", () => {
    assert.equal(queueWaitLabel("2026-11-08T11:59:30.000Z", NOW, "second"), "30s");
    assert.equal(queueWaitLabel("2026-11-08T11:56:50.000Z", NOW, "second"), "3m 10s");
  });

  it("says nothing without a usable admission time", () => {
    assert.equal(queueWaitLabel(null, NOW, "second"), "");
    assert.equal(queueWaitLabel("not a date", NOW, "minute"), "");
    // A clock a little behind the server never shows a negative wait.
    assert.equal(queueWaitLabel("2026-11-08T12:00:05.000Z", NOW, "second"), "0s");
  });
});
