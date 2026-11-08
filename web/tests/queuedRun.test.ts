import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { queuedRun, queueWaitLabel } from "../src/lib/queuedRun.js";
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
