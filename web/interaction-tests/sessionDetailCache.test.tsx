import { afterEach, expect, it, vi } from "vitest";
import { readSessionDetails, removeSessionDetail, writeSessionDetail } from "../src/lib/sessionDetailCache";
import type { RelaySession } from "../src/types";

const detail = (id: string) => ({ hydratedAt: Date.now(), snapshot: { id, taskGoal: "Task", status: "running", createdAt: "2026-01-01", updatedAt: "2026-01-01", events: [], agentRuns: [] } as unknown as RelaySession });
afterEach(() => sessionStorage.clear());

it("bounds stored details and replaces earlier copies of a thread", () => {
  for (let i = 0; i < 10; i++) writeSessionDetail("alice", detail(String(i)));
  expect(readSessionDetails("alice").map(row => row.snapshot.id)).toEqual(["9", "8", "7", "6", "5", "4", "3", "2"]);
  writeSessionDetail("alice", detail("5"));
  expect(readSessionDetails("alice")).toHaveLength(8);
  expect(readSessionDetails("alice")[0].snapshot.id).toBe("5");
  expect(readSessionDetails("bob")).toEqual([]);
});

it("expires old data and treats corrupted storage as a cache miss", () => {
  writeSessionDetail("alice", { ...detail("old"), hydratedAt: Date.now() - 86_400_001 });
  expect(readSessionDetails("alice")).toEqual([]);
  for (const value of ["invalid JSON", "{}", '[{"snapshot":null}]']) {
    sessionStorage.setItem("relay.thread-details.v1:alice", value);
    expect(readSessionDetails("alice")).toEqual([]);
  }
});

it("tolerates unavailable storage and bounds the size of individual transcripts", () => {
  writeSessionDetail("alice", { ...detail("large"), snapshot: { ...detail("large").snapshot, taskGoal: "x".repeat(2_000_001) } });
  expect(readSessionDetails("alice")).toEqual([]);
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
  expect(() => writeSessionDetail("alice", detail("next"))).not.toThrow();
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("disabled"); });
  expect(readSessionDetails("alice")).toEqual([]);
});


it("rejects incomplete snapshots and timestamps from the future", () => {
  sessionStorage.setItem("relay.thread-details.v1:alice", JSON.stringify([{ hydratedAt: Date.now(), snapshot: { id: "broken", events: [], agentRuns: [] } }]));
  expect(readSessionDetails("alice")).toEqual([]);
  writeSessionDetail("alice", { ...detail("future"), hydratedAt: Date.now() + 60_000 });
  expect(readSessionDetails("alice")).toEqual([]);
});


it("evicts a deleted thread without removing another account's cache", () => {
  writeSessionDetail("alice", detail("thread"));
  writeSessionDetail("bob", detail("thread"));
  removeSessionDetail("alice", "thread");
  expect(readSessionDetails("alice")).toEqual([]);
  expect(readSessionDetails("bob")).toHaveLength(1);
});
