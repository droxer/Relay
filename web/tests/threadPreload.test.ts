import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { threadPreloadKey } from "../src/lib/threadPreload.js";
import type { RelaySession } from "../src/types.js";

function thread(id: string, loaded = false): RelaySession {
  return {
    id,
    workspacePath: "/workspace",
    taskGoal: id,
    participants: ["human"],
    status: "completed",
    phase: "done",
    createdAt: "2026-06-20T00:00:00.000Z",
    updatedAt: "2026-06-20T00:00:00.000Z",
    agentRuns: [],
    artifacts: [],
    decisions: [],
    collaborationRounds: [],
    // Only the count matters to the key, not the event's shape.
    events: loaded ? [{ id: `${id}-e` }] as unknown as RelaySession["events"] : [],
  } as RelaySession;
}

describe("thread preload", () => {
  it("names first-page threads with no cached transcript, in list order", () => {
    const sessions = [thread("a"), thread("b", true), thread("c")];
    assert.equal(threadPreloadKey(sessions), "a\nc");
  });

  it("stops at the first page", () => {
    const sessions = Array.from({ length: 25 }, (_, index) => thread(`t${index}`));
    const key = threadPreloadKey(sessions);
    assert.equal(key.split("\n").length, 20);
    assert.ok(!key.includes("t20"));
  });

  it("is empty when everything is cached", () => {
    assert.equal(threadPreloadKey([thread("a", true)]), "");
  });
});
