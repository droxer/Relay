import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  UNKNOWN_BLOCKER_SENTINEL,
  taskBlocker,
  taskExceptions,
  taskWorkAgeDays,
} from "../src/lib/taskExceptions.js";
import type { RelaySession, RelayTask } from "../src/types.js";

function task(input: Partial<RelayTask> & { id: string; title: string }): RelayTask {
  return {
    id: input.id,
    title: input.title,
    description: input.description ?? "",
    priority: input.priority ?? "normal",
    status: input.status ?? "backlog",
    ownerEmployeeId: input.ownerEmployeeId ?? "alice",
    assigneeEmployeeId: input.assigneeEmployeeId,
    dueDate: input.dueDate,
    isRoutine: input.isRoutine ?? false,
    routineEnabled: input.routineEnabled ?? false,
    sourceRoutineId: input.sourceRoutineId,
    startedAt: input.startedAt,
    blockerReason: input.blockerReason,
    attention: input.attention,
    assignedAgentId: input.assignedAgentId,
    assignedTeamId: input.assignedTeamId,
    linkedSessionIds: input.linkedSessionIds ?? [],
    activity: input.activity ?? [],
    createdAt: input.createdAt ?? "2026-06-01T00:00:00.000Z",
    updatedAt: input.updatedAt ?? "2026-06-01T00:00:00.000Z",
    events: input.events ?? [],
  } as RelayTask;
}

function execution(phase: string): RelaySession["execution"] {
  return { phase } as RelaySession["execution"];
}

describe("taskWorkAgeDays", () => {
  it("is null for a task that never started", () => {
    assert.equal(taskWorkAgeDays(task({ id: "t1", title: "One" })), null);
  });

  it("is null for finished work, however long it took", () => {
    const started = new Date(Date.now() - 5 * 86400000).toISOString();
    assert.equal(taskWorkAgeDays(task({ id: "t1", title: "One", status: "done", startedAt: started })), null);
  });

  it("counts days since the run started", () => {
    const started = new Date(Date.now() - 2.5 * 86400000).toISOString();
    const age = taskWorkAgeDays(task({ id: "t1", title: "One", status: "running", startedAt: started }));
    assert.ok(age !== null);
    assert.ok(Math.abs((age as number) - 2.5) < 0.01);
  });

  it("never reports negative age for a clock-skewed start", () => {
    const started = new Date(Date.now() + 86400000).toISOString();
    assert.equal(taskWorkAgeDays(task({ id: "t1", title: "One", status: "running", startedAt: started })), 0);
  });
});

describe("taskBlocker", () => {
  it("reads the attention summary first", () => {
    const blocker = taskBlocker(task({
      id: "t1",
      title: "One",
      blockerReason: "stale",
      attention: { schemaVersion: 1, code: "x", source: "execution", summary: "Agent lost its node", evidence: "recorded", observedAt: "2026-06-01T00:00:00.000Z" },
    }));
    assert.deepEqual(blocker, { unknown: false, reason: "Agent lost its node" });
  });

  it("falls back to the recorded blocker reason", () => {
    const blocker = taskBlocker(task({ id: "t1", title: "One", blockerReason: "Waiting on credentials" }));
    assert.deepEqual(blocker, { unknown: false, reason: "Waiting on credentials" });
  });

  it("reports unknown when the evidence says so", () => {
    const blocker = taskBlocker(task({
      id: "t1",
      title: "One",
      blockerReason: "Anything at all",
      attention: { schemaVersion: 1, code: "x", source: "execution", summary: "Anything at all", evidence: "unknown", observedAt: "2026-06-01T00:00:00.000Z" },
    }));
    assert.deepEqual(blocker, { unknown: true, reason: null });
  });

  it("treats the legacy sentinel reason as unknown", () => {
    const blocker = taskBlocker(task({ id: "t1", title: "One", blockerReason: UNKNOWN_BLOCKER_SENTINEL }));
    assert.deepEqual(blocker, { unknown: true, reason: null });
  });

  it("reports no reason rather than a blank one", () => {
    assert.deepEqual(taskBlocker(task({ id: "t1", title: "One" })), { unknown: false, reason: null });
    assert.deepEqual(taskBlocker(task({ id: "t1", title: "One", blockerReason: "   " })), { unknown: false, reason: null });
  });
});

describe("taskExceptions", () => {
  it("is empty for work that is simply moving", () => {
    assert.deepEqual(taskExceptions(task({ id: "t1", title: "One", status: "assigned" }), undefined), []);
  });

  it("reports a recovering session before anything else", () => {
    const started = new Date(Date.now() - 86400000).toISOString();
    const exceptions = taskExceptions(
      task({ id: "t1", title: "One", status: "running", startedAt: started }),
      execution("reconciling"),
    );
    assert.equal(exceptions[0]?.kind, "recovering");
    assert.deepEqual(exceptions.map((item: { kind: string }) => item.kind), ["recovering", "age"]);
  });

  it("says nothing about a session that is running normally", () => {
    assert.deepEqual(taskExceptions(task({ id: "t1", title: "One" }), execution("running")), []);
    assert.deepEqual(taskExceptions(task({ id: "t1", title: "One" }), execution("terminal")), []);
  });

  it("carries the blocker reason through", () => {
    const exceptions = taskExceptions(
      task({ id: "t1", title: "One", status: "blocked", blockerReason: "Needs a key" }),
      undefined,
    );
    assert.deepEqual(exceptions, [{ kind: "blocked", unknown: false, reason: "Needs a key" }]);
  });

  it("reports waiting for a human", () => {
    const exceptions = taskExceptions(task({ id: "t1", title: "One", status: "waiting_for_human" }), undefined);
    assert.deepEqual(exceptions, [{ kind: "waiting" }]);
  });
});

/* The card is a tile now: a title and one facts line. Everything it used to
   carry — the description, the exception line, the routine badge, the file
   count, the ref, and the action bar — moved into the record drawer, and
   these assertions are what stops any of it drifting back. */
describe("the backlog card stays a tile", () => {
  const source = readFileSync("web/src/components/task-board/BacklogRecords.tsx", "utf8");
  const card = source.slice(
    source.indexOf("export function BacklogTaskCard"),
    source.indexOf("export function BacklogTaskList"),
  );

  it("renders no action buttons", () => {
    assert.ok(card.length > 0);
    assert.ok(!card.includes("backlog-task-actions"), "the card must not carry an action bar");
    assert.ok(!card.includes("backlog-action-group"), "the card must not carry action groups");
    assert.ok(!card.includes("<Button"), "the card must not render buttons");
  });

  it("renders no description, ref, or origin badge", () => {
    assert.ok(!card.includes("backlog-description"), "the description belongs to the drawer");
    assert.ok(!card.includes("TaskReference"), "the ref belongs to the drawer");
    assert.ok(!card.includes("RoutineOriginBadge"), "the origin badge belongs to the drawer");
    assert.ok(!card.includes("backlog-result-files"), "the file count belongs to the drawer");
    assert.ok(!card.includes("TaskFlowDetails"), "the exception line belongs to the drawer");
  });

  it("keeps the title a real link to the record", () => {
    assert.ok(card.includes("hrefForTaskRecord(task.id)"), "cmd-click must still reach the record route");
    assert.ok(card.includes("onOpen"), "a plain click must open the record drawer");
  });

  it("keeps selection and drag intact", () => {
    assert.ok(card.includes("TaskSelectCheckbox"));
    // Drag arrives from the board's KanbanItem as props on the card's root.
    assert.ok(card.includes("{...dragProps}"), "the card must apply the kanban item's drag wiring");
    // A native HTML5 drag would fight dnd-kit's pointer sensors.
    assert.ok(!/\bdraggable\b/.test(card), "the card must not be natively draggable");
  });
});
