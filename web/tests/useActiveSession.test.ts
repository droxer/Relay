import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { pickInitialActiveSessionId, shouldDeriveActiveSession } from "../src/hooks/useActiveSession.js";

describe("pickInitialActiveSessionId", () => {
  it("returns stored id when session exists and is not archived", () => {
    const sessions = [
      { id: "s1", archived: false, createdAt: "2026-06-01" },
      { id: "s2", archived: false, createdAt: "2026-06-10" },
    ];
    assert.equal(pickInitialActiveSessionId("s2", sessions), "s2");
  });

  it("falls back to newest non-archived session when stored id is missing", () => {
    const sessions = [
      { id: "s1", archived: false, createdAt: "2026-06-01" },
      { id: "s2", archived: false, createdAt: "2026-06-10" },
    ];
    assert.equal(pickInitialActiveSessionId(null, sessions), "s2");
  });

  it("falls back to the most recently updated non-archived session", () => {
    const sessions = [
      { id: "created-newer", archived: false, createdAt: "2026-06-10", updatedAt: "2026-06-10T00:00:00.000Z" },
      { id: "updated-newer", archived: false, createdAt: "2026-06-01", updatedAt: "2026-06-20T00:00:00.000Z" },
    ];
    assert.equal(pickInitialActiveSessionId(null, sessions), "updated-newer");
  });

  it("skips archived sessions on fallback", () => {
    const sessions = [
      { id: "s1", archived: false, createdAt: "2026-06-01" },
      { id: "s2", archived: true, createdAt: "2026-06-10" },
    ];
    assert.equal(pickInitialActiveSessionId(null, sessions), "s1");
  });

  it("returns null when no eligible session", () => {
    assert.equal(pickInitialActiveSessionId(null, []), null);
  });

  it("returns null when stored id points to archived session and no other eligible", () => {
    const sessions = [{ id: "s2", archived: true, createdAt: "2026-06-10" }];
    assert.equal(pickInitialActiveSessionId("s2", sessions), null);
  });

  it("falls back to newest non-archived when stored id is missing from list", () => {
    const sessions = [{ id: "s1", archived: false, createdAt: "2026-06-01" }];
    assert.equal(pickInitialActiveSessionId("ghost", sessions), "s1");
  });
});

describe("shouldDeriveActiveSession", () => {
  it("derives the opening thread once the first load has landed", () => {
    assert.equal(shouldDeriveActiveSession({ userId: "alice", derivedFor: null, sessionCount: 2 }), true);
  });

  it("waits for the first load instead of deriving from an empty list", () => {
    assert.equal(shouldDeriveActiveSession({ userId: "alice", derivedFor: null, sessionCount: 0 }), false);
  });

  // The regression guard: re-deriving on every poll tick / streamed update
  // drags the selection back to the most recent thread, undoing an explicit
  // "new thread" (which clears both the selection and its stored id).
  it("does not re-derive when the session list changes for the same user", () => {
    assert.equal(shouldDeriveActiveSession({ userId: "alice", derivedFor: "alice", sessionCount: 3 }), false);
  });

  it("derives again after switching user", () => {
    assert.equal(shouldDeriveActiveSession({ userId: "bob", derivedFor: "alice", sessionCount: 3 }), true);
  });

  it("never derives without a user", () => {
    assert.equal(shouldDeriveActiveSession({ userId: "", derivedFor: null, sessionCount: 3 }), false);
  });
});
