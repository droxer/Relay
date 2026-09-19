import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { filterRoutineTasks, latestRoutineSession, routineDueTone, routineState, routineStateCounts, ROUTINE_STATE_ORDER, runningRoutineCount, runningRoutineIds, type RoutineFilters } from "../src/lib/routine.js";
import type { RelaySession, RelayTask } from "../src/types.js";

const baseFilters: RoutineFilters = {
  query: "",
  type: "all",
  cadence: "all",
  agent: "all",
  assignee: "",
  state: "all",
};

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
    routineType: input.routineType,
    routineCadence: input.routineCadence,
    routineNextRunDate: input.routineNextRunDate,
    routineEnabled: input.routineEnabled ?? false,
    assignedAgent: input.assignedAgent,
    assignedAgentId: input.assignedAgentId,
    sourceRoutineId: input.sourceRoutineId,
    scheduledFor: input.scheduledFor,
    occurrenceIds: input.occurrenceIds,
    linkedSessionIds: input.linkedSessionIds ?? [],
    activity: input.activity ?? [],
    createdAt: input.createdAt ?? "2026-06-01T00:00:00.000Z",
    updatedAt: input.updatedAt ?? "2026-06-01T00:00:00.000Z",
    events: input.events ?? [],
  } as RelayTask;
}

describe("filterRoutineTasks", () => {
  it("keeps only routine tasks and filters by routine metadata", () => {
    const tasks = [
      task({ id: "a", title: "Daily health check", isRoutine: true, routineType: "job", routineCadence: "daily", routineEnabled: true, routineNextRunDate: "2026-06-24", assignedAgent: "codex", assignedAgentId: "agent_health", assigneeEmployeeId: "alice" }),
      task({ id: "b", title: "Weekly report", isRoutine: true, routineType: "task", routineCadence: "weekly", routineEnabled: true, routineNextRunDate: "2026-06-30", assignedAgent: "claude", assigneeEmployeeId: "bob" }),
      task({ id: "c", title: "Plain backlog item", isRoutine: false, assignedAgent: "codex", assigneeEmployeeId: "alice" }),
    ];

    const result = filterRoutineTasks(tasks, {
      ...baseFilters,
      query: "health",
      type: "job",
      cadence: "daily",
      agent: "agent_health",
      assignee: "ali",
      state: "due",
    }, "2026-06-24");

    assert.deepEqual(result.map((item) => item.id), ["a"]);
  });

  it("filters by the exact schedule states shown in routine records", () => {
    const tasks = [
      task({ id: "running", title: "Running", isRoutine: true, routineEnabled: false }),
      task({ id: "running-occurrence", title: "Running occurrence", sourceRoutineId: "running", status: "running" }),
      task({ id: "overdue", title: "Overdue", isRoutine: true, routineEnabled: true, routineNextRunDate: "2026-06-23" }),
      task({ id: "due", title: "Due", isRoutine: true, routineEnabled: true, routineNextRunDate: "2026-06-24" }),
      task({ id: "scheduled", title: "Scheduled", isRoutine: true, routineEnabled: true, routineNextRunDate: "2026-06-25" }),
      task({ id: "unscheduled", title: "Unscheduled", isRoutine: true, routineEnabled: true }),
      task({ id: "paused", title: "Paused", isRoutine: true, routineEnabled: false }),
    ];

    for (const state of ROUTINE_STATE_ORDER) {
      const result = filterRoutineTasks(tasks, { ...baseFilters, state }, "2026-06-24");
      assert.deepEqual(result.map((item) => item.id), [state], state);
    }
  });
});

describe("latestRoutineSession", () => {
  it("opens the newest automatically scheduled occurrence session through structured lineage", () => {
    const routine = task({
      id: "routine-a",
      title: "Daily check",
      isRoutine: true,
      occurrenceIds: ["occurrence-old", "occurrence-new"],
    });
    const tasks = [
      routine,
      task({ id: "occurrence-new", title: "New", sourceRoutineId: routine.id, scheduledFor: "2026-07-21", linkedSessionIds: ["session-new"] }),
      task({ id: "occurrence-old", title: "Old", sourceRoutineId: routine.id, scheduledFor: "2026-07-20", linkedSessionIds: ["session-old"] }),
    ];
    const sessions = [
      { id: "session-old" } as RelaySession,
      { id: "session-new" } as RelaySession,
    ];

    assert.equal(latestRoutineSession(routine, tasks, sessions)?.id, "session-new");
  });
});

describe("routineDueTone", () => {
  it("uses enabled state and next-run dates independently from backlog status", () => {
    assert.equal(routineDueTone(task({ id: "a", title: "A", isRoutine: true, routineEnabled: true, routineNextRunDate: "2026-06-23" }), "2026-06-24"), "bad");
    assert.equal(routineDueTone(task({ id: "b", title: "B", isRoutine: true, routineEnabled: true, routineNextRunDate: "2026-06-24" }), "2026-06-24"), "warn");
    assert.equal(routineDueTone(task({ id: "c", title: "C", isRoutine: true, routineEnabled: false, routineNextRunDate: "2026-06-23" }), "2026-06-24"), "neutral");
    assert.equal(routineDueTone(task({ id: "d", title: "D", isRoutine: true, routineEnabled: true, routineNextRunDate: "2026-06-23", status: "done" }), "2026-06-24"), "bad");
  });
});

describe("routineState", () => {
  const none = new Set<string>();

  it("derives schedule health from the enabled flag and the next-run date", () => {
    const routine = (id: string, extra: Partial<RelayTask>) =>
      task({ id, title: id, isRoutine: true, routineEnabled: true, ...extra });

    assert.equal(routineState(routine("a", { routineNextRunDate: "2026-06-23" }), none, "2026-06-24"), "overdue");
    assert.equal(routineState(routine("b", { routineNextRunDate: "2026-06-24" }), none, "2026-06-24"), "due");
    assert.equal(routineState(routine("c", { routineNextRunDate: "2026-06-25" }), none, "2026-06-24"), "scheduled");
    assert.equal(routineState(routine("d", {}), none, "2026-06-24"), "unscheduled");
    assert.equal(routineState(routine("e", { routineEnabled: false, routineNextRunDate: "2026-06-23" }), none, "2026-06-24"), "paused");
  });

  it("ignores the routine's own backlog status, which never advances", () => {
    const routine = task({ id: "a", title: "A", isRoutine: true, routineEnabled: true, routineNextRunDate: "2026-06-25", status: "blocked" });
    assert.equal(routineState(routine, none, "2026-06-24"), "scheduled");
  });

  it("reports a live occurrence ahead of every scheduling state, including paused", () => {
    const running = new Set(["a", "b"]);
    assert.equal(routineState(task({ id: "a", title: "A", isRoutine: true, routineEnabled: true, routineNextRunDate: "2026-06-23" }), running, "2026-06-24"), "running");
    assert.equal(routineState(task({ id: "b", title: "B", isRoutine: true, routineEnabled: false }), running, "2026-06-24"), "running");
  });
});

describe("runningRoutineIds", () => {
  it("collects source routines of occurrences that are running or in review", () => {
    const tasks = [
      task({ id: "routine-a", title: "A", isRoutine: true }),
      task({ id: "occ-a", title: "A run", sourceRoutineId: "routine-a", status: "running" }),
      task({ id: "occ-b", title: "B run", sourceRoutineId: "routine-b", status: "review" }),
      task({ id: "occ-c", title: "C run", sourceRoutineId: "routine-c", status: "done" }),
      task({ id: "loose", title: "Loose", status: "running" }),
    ];

    assert.deepEqual([...runningRoutineIds(tasks)].sort(), ["routine-a", "routine-b"]);
  });
});

describe("runningRoutineCount", () => {
  it("derives running definitions from their active occurrence tasks", () => {
    const routines = [
      task({ id: "routine-a", title: "A", isRoutine: true }),
      task({ id: "routine-b", title: "B", isRoutine: true }),
    ];
    const tasks = [
      ...routines,
      task({ id: "occ-a", title: "A run", sourceRoutineId: "routine-a", status: "running" }),
      task({ id: "occ-b", title: "B run", sourceRoutineId: "routine-b", status: "done" }),
    ];

    assert.equal(runningRoutineCount(routines, tasks), 1);
  });
});

describe("routineStateCounts", () => {
  it("counts every routine under the state its own row would render", () => {
    const routines = [
      task({ id: "a", title: "A", isRoutine: true, routineEnabled: true, routineNextRunDate: "2026-01-01" }),
      task({ id: "b", title: "B", isRoutine: true, routineEnabled: true, routineNextRunDate: "2026-05-05" }),
      task({ id: "c", title: "C", isRoutine: true, routineEnabled: false, routineNextRunDate: "2026-05-05" }),
      task({ id: "d", title: "D", isRoutine: true, routineEnabled: true }),
    ];

    const counts = routineStateCounts(routines, new Set(), "2026-05-05");

    assert.equal(counts.overdue, 1);
    assert.equal(counts.due, 1);
    assert.equal(counts.paused, 1);
    assert.equal(counts.unscheduled, 1);
    // A section the rail renders has to hold a number even when nothing is in
    // it, or the row reads `counts[state]` as undefined and prints nothing
    // where a `0` belongs.
    assert.equal(counts.running, 0);
    assert.equal(counts.scheduled, 0);
    for (const state of ROUTINE_STATE_ORDER) assert.equal(typeof counts[state], "number");
  });

  it("counts a routine in exactly one section", () => {
    const routines = [
      task({ id: "a", title: "A", isRoutine: true, routineEnabled: true, routineNextRunDate: "2026-05-05" }),
      task({ id: "b", title: "B", isRoutine: true, routineEnabled: false }),
    ];

    const counts = routineStateCounts(routines, new Set(["a"]), "2026-05-05");
    const total = ROUTINE_STATE_ORDER.reduce((sum, state) => sum + counts[state], 0);

    assert.equal(total, routines.length);
    // Running outranks the schedule, same as `routineState`.
    assert.equal(counts.running, 1);
  });
});
