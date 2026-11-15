import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { historyDays, taskHistoryEntries, threadLinkEntryIds } from "../src/lib/taskHistory.js";
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

describe("status moves", () => {
  it("says where each move came from, so the label can tell a resume from a start", () => {
    const entries = taskHistoryEntries([
      event({ id: "e1", type: "task.status", timestamp: "2026-06-01T00:00:00.000Z", status: "running" } as never),
      event({ id: "e2", type: "task.status", timestamp: "2026-06-01T01:00:00.000Z", status: "waiting_for_human", reason: "Which release?" } as never),
      event({ id: "e3", type: "task.status", timestamp: "2026-06-01T02:00:00.000Z", status: "running", actorUserId: "u" } as never),
    ], "task_1");

    assert.deepEqual(entries.map((entry) => [entry.from, entry.status]), [
      ["waiting_for_human", "running"],
      ["running", "waiting_for_human"],
      ["backlog", "running"],
    ]);
    assert.equal(entries[0]?.actorUserId, "u");
    assert.equal(entries[1]?.actorUserId, undefined);
    // The reason is the fact the reader opened the history for.
    assert.equal(entries[1]?.message, "Which release?");
  });

  it("keeps the previous status right even past the newest-first cap", () => {
    const events = [
      event({ id: "s0", type: "task.status", timestamp: "2026-06-01T00:00:00.000Z", status: "review" } as never),
      ...Array.from({ length: 30 }, (_, index) =>
        event({ id: `l${index}`, type: "task.session_linked", timestamp: `2026-06-02T00:${String(index).padStart(2, "0")}:00.000Z`, sessionId: `s${index}` } as never)),
      event({ id: "s1", type: "task.status", timestamp: "2026-06-03T00:00:00.000Z", status: "done" } as never),
    ];
    assert.equal(taskHistoryEntries(events, "task_1")[0]?.from, "review");
  });
});

describe("historyDays", () => {
  it("groups newest-first entries under their local day, newest day first", () => {
    const at = (day: number, hour: number) => new Date(2026, 5, day, hour).toISOString();
    const entries = taskHistoryEntries([
      event({ id: "e1", type: "task.created", timestamp: at(1, 9) }),
      event({ id: "e2", type: "task.status", timestamp: at(1, 10), status: "running" } as never),
      event({ id: "e3", type: "task.status", timestamp: at(3, 8), status: "done" } as never),
    ], "task_1");

    const days = historyDays(entries);
    assert.deepEqual(days.map((day) => [day.key, day.entries.map((entry) => entry.id)]), [
      ["2026-06-03", ["e3"]],
      ["2026-06-01", ["e2", "e1"]],
    ]);
  });
});

describe("threadLinkEntryIds", () => {
  it("links each thread once, on its newest entry", () => {
    const entries = taskHistoryEntries([
      event({ id: "e1", type: "task.session_linked", timestamp: "2026-06-01T00:00:00.000Z", sessionId: "session_1" } as never),
      event({
        id: "e2",
        type: "task.activity",
        timestamp: "2026-06-02T00:00:00.000Z",
        activity: { id: "act_1", createdAt: "2026-06-02T00:00:00.000Z", message: "Dispatched to claude", sessionId: "session_1" },
      } as never),
      event({
        id: "e3",
        type: "task.activity",
        timestamp: "2026-06-03T00:00:00.000Z",
        activity: { id: "act_2", createdAt: "2026-06-03T00:00:00.000Z", message: "Round finished", sessionId: "session_1" },
      } as never),
      event({ id: "e4", type: "task.status", timestamp: "2026-06-04T00:00:00.000Z", status: "review" } as never),
    ], "task_1");

    assert.deepEqual([...threadLinkEntryIds(entries)], ["e3"]);
  });

  it("keeps one link per distinct thread", () => {
    const entries = taskHistoryEntries([
      event({ id: "e1", type: "task.session_linked", timestamp: "2026-06-01T00:00:00.000Z", sessionId: "session_1" } as never),
      event({ id: "e2", type: "task.session_linked", timestamp: "2026-06-02T00:00:00.000Z", sessionId: "session_2" } as never),
      event({ id: "e3", type: "task.session_unlinked", timestamp: "2026-06-03T00:00:00.000Z", sessionId: "session_1" } as never),
    ], "task_1");

    assert.deepEqual([...threadLinkEntryIds(entries)].sort(), ["e2", "e3"]);
  });
});
