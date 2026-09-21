import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { taskHistoryEntries } from "../src/lib/taskHistory.js";
import type { RelayTaskEvent } from "../src/types.js";

function event(input: Partial<RelayTaskEvent> & { id: string; type: RelayTaskEvent["type"]; timestamp: string }): RelayTaskEvent {
  return { taskId: "task_1", ...input } as RelayTaskEvent;
}

describe("taskHistoryEntries", () => {
  it("keeps run events and drops edit/claim bookkeeping", () => {
    const entries = taskHistoryEntries([
      event({ id: "e1", type: "task.created", timestamp: "2026-06-01T00:00:00.000Z" }),
      event({ id: "e2", type: "task.updated", timestamp: "2026-06-02T00:00:00.000Z" }),
      event({ id: "e3", type: "task.dispatch_claimed", timestamp: "2026-06-03T00:00:00.000Z" }),
      event({ id: "e4", type: "task.status", timestamp: "2026-06-04T00:00:00.000Z", status: "running" } as never),
    ], "task_1");

    assert.deepEqual(entries.map((entry) => entry.kind), ["status", "created"]);
    assert.equal(entries[0]?.status, "running");
  });

  it("orders newest first and caps the list", () => {
    const events = Array.from({ length: 30 }, (_, index) =>
      event({
        id: `e${index}`,
        type: "task.session_linked",
        timestamp: `2026-06-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
        sessionId: `session_${index}`,
      } as never),
    );

    const entries = taskHistoryEntries(events, "task_1");
    assert.equal(entries.length, 25);
    assert.equal(entries[0]?.sessionId, "session_29");
  });

  it("marks occurrence events so a routine's own entries stay distinguishable", () => {
    const entries = taskHistoryEntries([
      event({ id: "e1", type: "task.occurrence_created", timestamp: "2026-06-01T00:00:00.000Z", occurrenceId: "task_occ", scheduledFor: "2026-06-01" } as never),
      event({ id: "e2", taskId: "task_occ", type: "task.status", timestamp: "2026-06-02T00:00:00.000Z", status: "done" } as never),
    ], "routine_1");

    const [status, occurrence] = entries;
    assert.equal(status?.fromOccurrence, true);
    assert.equal(status?.taskId, "task_occ");
    // The routine's own promotion entry points at the occurrence it created.
    assert.equal(occurrence?.kind, "occurrence");
    assert.equal(occurrence?.fromOccurrence, false);
    assert.equal(occurrence?.taskId, "task_occ");
  });

  it("carries activity messages and their thread through", () => {
    const entries = taskHistoryEntries([
      event({
        id: "e1",
        type: "task.activity",
        timestamp: "2026-06-01T00:00:00.000Z",
        activity: { id: "act_1", createdAt: "2026-06-01T00:00:00.000Z", message: "Dispatched to claude", sessionId: "session_9" },
      } as never),
      event({ id: "e2", type: "task.dispatch_outcome", timestamp: "2026-06-02T00:00:00.000Z", outcome: { state: "rejected", message: "no ready node" } } as never),
    ], "task_1");

    assert.equal(entries[1]?.message, "Dispatched to claude");
    assert.equal(entries[1]?.sessionId, "session_9");
    assert.equal(entries[0]?.kind, "dispatch_rejected");
    assert.equal(entries[0]?.message, "no ready node");
  });
  it("drops activity lines that restate a structured event with a raw id", () => {
    const entries = taskHistoryEntries([
      event({ id: "e1", type: "task.assigned", timestamp: "2026-06-01T00:00:00.000Z", teamId: "team_9" } as never),
      event({
        id: "e2",
        type: "task.activity",
        timestamp: "2026-06-01T00:00:01.000Z",
        activity: { id: "act_1", createdAt: "2026-06-01T00:00:01.000Z", message: "Assigned to team team_9." },
      } as never),
      event({ id: "e3", type: "task.session_linked", timestamp: "2026-06-02T00:00:00.000Z", sessionId: "session_1" } as never),
      event({
        id: "e4",
        type: "task.activity",
        timestamp: "2026-06-02T00:00:01.000Z",
        activity: { id: "act_2", createdAt: "2026-06-02T00:00:01.000Z", message: "Linked session session_1." },
      } as never),
      event({
        id: "e5",
        type: "task.activity",
        timestamp: "2026-06-03T00:00:00.000Z",
        activity: { id: "act_3", createdAt: "2026-06-03T00:00:00.000Z", message: "Picked up by the node" },
      } as never),
    ], "task_1");

    // The id-bearing duplicates are gone; the structured entries and a real
    // activity line survive.
    assert.deepEqual(entries.map((entry) => entry.kind), ["activity", "session_linked", "assigned"]);
    assert.equal(entries[0]?.message, "Picked up by the node");
    // The assignment entry carries its target so the label can print a name.
    assert.equal(entries[2]?.teamId, "team_9");
  });
});
