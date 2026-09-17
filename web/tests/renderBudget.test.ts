import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { groupThreads } from "../src/lib/threadGroups.js";
import { limitThreadGroups, railLimitFor, RAIL_PAGE_SIZE, reuseThreadItems, type ThreadItem } from "../src/lib/threads.js";
import { formatThreadStamp, threadStampFormatter } from "../src/lib/threadStamp.js";
import { nextTranscriptWindow, transcriptVisibleAfter, transcriptWindowStart, TRANSCRIPT_PAGE_SIZE } from "../src/lib/transcriptWindow.js";
import type { RelaySession } from "../src/types.js";

function session(id: string, status: RelaySession["status"] = "completed"): RelaySession {
  return {
    id, workspacePath: "/w", ownerEmployeeId: "alice", taskGoal: id, participants: ["human"],
    status, phase: status, createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z",
    agentRuns: [], artifacts: [], decisions: [], events: [],
  } as unknown as RelaySession;
}

describe("reuseThreadItems", () => {
  // Rows are memoized on their item. The directory rebuilt every item object
  // whenever any input moved — a node poll, a task poll — so memoization held
  // nothing and all 400 rows re-rendered together.
  it("keeps the previous object for an item whose fields are unchanged", () => {
    const a = session("a");
    const b = session("b");
    const previous: ThreadItem[] = [{ session: a }, { session: b, origin: { kind: "backlog", taskId: "t", title: "T" } }];
    const next: ThreadItem[] = [{ session: a }, { session: b, origin: { kind: "backlog", taskId: "t", title: "T" } }];
    const reused = reuseThreadItems(previous, next);
    assert.equal(reused[0], previous[0]);
    assert.equal(reused[1], previous[1]);
  });

  it("returns the previous array when every item is reused in the same order", () => {
    const a = session("a");
    const previous: ThreadItem[] = [{ session: a }];
    assert.equal(reuseThreadItems(previous, [{ session: a }]), previous);
  });

  it("takes the new object when the session or a decoration changed", () => {
    const a = session("a");
    const previous: ThreadItem[] = [{ session: a }, { session: session("b") }];
    const next: ThreadItem[] = [{ session: a, runningAgent: "claude" }, { session: session("b") }];
    const reused = reuseThreadItems(previous, next);
    assert.equal(reused[0], next[0]);
    assert.equal(reused[1], next[1]);
    assert.notEqual(reused, previous);
  });
});

describe("thread stamp", () => {
  // Constructing an Intl.RelativeTimeFormat per row per render was the single
  // hottest function while the rail sat idle.
  it("builds one formatter per locale", () => {
    assert.equal(threadStampFormatter("en"), threadStampFormatter("en"));
    assert.notEqual(threadStampFormatter("en"), threadStampFormatter("zh-CN"));
  });

  it("formats against the supplied clock", () => {
    const now = Date.parse("2026-09-17T12:00:00Z");
    assert.equal(formatThreadStamp("2026-09-17T11:00:00Z", "en", now), "1h ago");
    assert.equal(formatThreadStamp("2026-09-14T12:00:00Z", "en", now), "3d ago");
    assert.equal(formatThreadStamp(undefined, "en", now), "");
    assert.equal(formatThreadStamp("not a date", "en", now), "");
  });
});

describe("thread rail window", () => {
  const items: ThreadItem[] = Array.from({ length: 10 }, (_, i) =>
    ({ session: session(`s${i}`, i < 3 ? "waiting_for_human" : "completed") }));

  it("keeps the first rows across groups in attention order, and the full counts", () => {
    const limited = limitThreadGroups(groupThreads(items), 4);
    assert.deepEqual(limited.needsYou.items.map((item) => item.session.id), ["s0", "s1", "s2"]);
    assert.deepEqual(limited.idle.items.map((item) => item.session.id), ["s3"]);
    assert.equal(limited.idle.total, 7);
    assert.equal(limited.hasMore, true);
  });

  it("reports nothing more when the limit covers the list", () => {
    assert.equal(limitThreadGroups(groupThreads(items), 10).hasMore, false);
  });

  it("extends the window in whole pages to reach the selected thread", () => {
    assert.equal(railLimitFor(-1, RAIL_PAGE_SIZE), RAIL_PAGE_SIZE);
    assert.equal(railLimitFor(0, RAIL_PAGE_SIZE), RAIL_PAGE_SIZE);
    assert.equal(railLimitFor(RAIL_PAGE_SIZE, RAIL_PAGE_SIZE), RAIL_PAGE_SIZE * 2);
    assert.equal(railLimitFor(RAIL_PAGE_SIZE * 3 + 5, RAIL_PAGE_SIZE), RAIL_PAGE_SIZE * 4);
  });
});

describe("transcript window", () => {
  it("starts at the newest page", () => {
    assert.equal(transcriptWindowStart(150, TRANSCRIPT_PAGE_SIZE), 150 - TRANSCRIPT_PAGE_SIZE);
    assert.equal(transcriptWindowStart(10, TRANSCRIPT_PAGE_SIZE), 0);
  });

  it("grows by a page and never past the transcript", () => {
    assert.equal(nextTranscriptWindow(TRANSCRIPT_PAGE_SIZE, 150), TRANSCRIPT_PAGE_SIZE * 2);
    assert.equal(nextTranscriptWindow(140, 150), 150);
    assert.equal(nextTranscriptWindow(150, 150), 150);
  });

  // New output appends below the reader. Unmounting a turn from the top to
  // hold the count would shift everything they are reading.
  it("keeps every mounted turn when messages append", () => {
    assert.equal(transcriptVisibleAfter(150, TRANSCRIPT_PAGE_SIZE, 151), TRANSCRIPT_PAGE_SIZE + 1);
  });

  // A thread opens from its summary (no events) and hydrates to the full
  // history in one step; that is a first load, not 300 new messages.
  it("treats a jump of more than a page as a first load", () => {
    assert.equal(transcriptVisibleAfter(0, TRANSCRIPT_PAGE_SIZE, 300), TRANSCRIPT_PAGE_SIZE);
    assert.equal(transcriptVisibleAfter(1, 1, 300), TRANSCRIPT_PAGE_SIZE);
  });

  it("follows a shrinking transcript", () => {
    assert.equal(transcriptVisibleAfter(150, 80, 60), 60);
  });
});
