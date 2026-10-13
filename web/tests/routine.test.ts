import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { filterRoutineTasks, latestRoutineSession, routineState, routineStateCounts, ROUTINE_STATE_ORDER, runningRoutineIds, type RoutineFilters } from "../src/lib/routine.js";
import type { RelaySession, RelayTask } from "../src/types.js";

const baseFilters: RoutineFilters = {
  trigger: "all",
  query: "",
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
    routineTriggers: input.routineTriggers,
    routineState: input.routineState,
    routinePauseReason: input.routinePauseReason,
    routineNextRunAt: input.routineNextRunAt,
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

const DAILY = [{ kind: "schedule" as const, schedule: { timezone: "UTC", repeat: { every: "day" as const, at: "09:00" } } }];
const NOW = new Date("2026-06-24T12:00:00Z");
const PAST = "2026-06-24T09:00:00Z";
const FUTURE = "2026-06-25T09:00:00Z";

function automation(id: string, extra: Partial<RelayTask> = {}): RelayTask {
  return task({ id, title: id, isRoutine: true, routineState: "active", routineTriggers: DAILY, routineNextRunAt: FUTURE, ...extra });
}

describe("filterRoutineTasks", () => {
  it("keeps only routine tasks and filters by routine metadata", () => {
    const tasks = [
      automation("a", { title: "Daily health check", routineNextRunAt: PAST, assignedAgent: "codex", assignedAgentId: "agent_health", assigneeEmployeeId: "alice" }),
      automation("b", { title: "Weekly report", assignedAgent: "claude", assigneeEmployeeId: "bob" }),
      task({ id: "c", title: "Plain backlog item", isRoutine: false, assignedAgent: "codex", assigneeEmployeeId: "alice" }),
    ];

    const result = filterRoutineTasks(tasks, {
      ...baseFilters,
      query: "health",
      trigger: "schedule",
      agent: "agent_health",
      assignee: "ali",
      state: "due",
    }, NOW);

    assert.deepEqual(result.map((item) => item.id), ["a"]);
  });

  it("filters by trigger kind, with none meaning Run now only", () => {
    const tasks = [
      automation("schedule"),
      automation("webhook", { routineTriggers: [{ kind: "webhook" }], routineNextRunAt: undefined }),
      automation("both", { routineTriggers: [...DAILY, { kind: "webhook" }] }),
      automation("none", { routineTriggers: [], routineNextRunAt: undefined }),
    ];
    const ids = (trigger: RoutineFilters["trigger"]) =>
      filterRoutineTasks(tasks, { ...baseFilters, trigger }, NOW).map((item) => item.id).sort();
    assert.deepEqual(ids("webhook"), ["both", "webhook"]);
    assert.deepEqual(ids("schedule"), ["both", "schedule"]);
    assert.deepEqual(ids("none"), ["none"]);
  });

  it("filters by the exact schedule states shown in routine records", () => {
    const tasks = [
      automation("running", { routineState: "paused" }),
      task({ id: "running-occurrence", title: "Running occurrence", sourceRoutineId: "running", status: "running" }),
      automation("due", { routineNextRunAt: PAST }),
      automation("scheduled"),
      automation("listening", { routineTriggers: [{ kind: "webhook" }], routineNextRunAt: undefined }),
      automation("on_demand", { routineTriggers: [], routineNextRunAt: undefined }),
      automation("paused", { routineState: "paused_by_relay", routinePauseReason: "rate_limited" }),
    ];

    for (const state of ROUTINE_STATE_ORDER) {
      const result = filterRoutineTasks(tasks, { ...baseFilters, state }, NOW);
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

describe("routineState", () => {
  const none = new Set<string>();

  it("derives one state per branch", () => {
    assert.equal(routineState(automation("run"), new Set(["run"]), NOW), "running");
    assert.equal(routineState(automation("p", { routineState: "paused" }), none, NOW), "paused");
    assert.equal(routineState(automation("r", { routineState: "paused_by_relay" }), none, NOW), "paused");
    assert.equal(routineState(automation("l", { routineTriggers: [{ kind: "task_event", on: "created" }], routineNextRunAt: undefined }), none, NOW), "listening");
    assert.equal(routineState(automation("o", { routineTriggers: [], routineNextRunAt: undefined }), none, NOW), "on_demand");
    assert.equal(routineState(automation("d", { routineNextRunAt: PAST }), none, NOW), "due");
    assert.equal(routineState(automation("d2", { routineNextRunAt: NOW.toISOString() }), none, NOW), "due");
    assert.equal(routineState(automation("s"), none, NOW), "scheduled");
  });

  it("shows an exhausted one-off as on demand, retaining listening for mixed triggers", () => {
    const once = { kind: "schedule" as const, schedule: { timezone: "UTC", repeat: { once: "2026-01-01T09:00" } } };
    assert.equal(routineState(automation("finished", { routineTriggers: [once], routineNextRunAt: undefined }), none, NOW), "on_demand");
    assert.equal(routineState(automation("mixed", { routineTriggers: [once, { kind: "webhook" }], routineNextRunAt: undefined }), none, NOW), "listening");
  });

  it("calls a schedule plus an event trigger scheduled while a run is coming", () => {
    const mixed = automation("m", { routineTriggers: [...DAILY, { kind: "webhook" }] });
    assert.equal(routineState(mixed, none, NOW), "scheduled");
  });

  it("ignores the routine's own backlog status, which never advances", () => {
    assert.equal(routineState(automation("a", { status: "blocked" }), none, NOW), "scheduled");
  });

  it("reports a live occurrence ahead of every scheduling state, including paused", () => {
    const running = new Set(["a", "b"]);
    assert.equal(routineState(automation("a", { routineNextRunAt: PAST }), running, NOW), "running");
    assert.equal(routineState(automation("b", { routineState: "paused" }), running, NOW), "running");
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

describe("routineStateCounts", () => {
  it("counts every routine under the state its own row would render", () => {
    const routines = [
      automation("a", { routineNextRunAt: PAST }),
      automation("b"),
      automation("c", { routineState: "paused" }),
      automation("d", { routineTriggers: [], routineNextRunAt: undefined }),
    ];

    const counts = routineStateCounts(routines, new Set(), NOW);

    assert.equal(counts.due, 1);
    assert.equal(counts.scheduled, 1);
    assert.equal(counts.paused, 1);
    assert.equal(counts.on_demand, 1);
    // A section the rail renders has to hold a number even when nothing is in
    // it, or the row reads `counts[state]` as undefined and prints nothing
    // where a `0` belongs.
    assert.equal(counts.running, 0);
    assert.equal(counts.listening, 0);
    for (const state of ROUTINE_STATE_ORDER) assert.equal(typeof counts[state], "number");
  });

  it("counts a routine in exactly one section", () => {
    const routines = [automation("a"), automation("b", { routineState: "paused" })];

    const counts = routineStateCounts(routines, new Set(["a"]), NOW);
    const total = ROUTINE_STATE_ORDER.reduce((sum, state) => sum + counts[state], 0);

    assert.equal(total, routines.length);
    // Running outranks the schedule, same as `routineState`.
    assert.equal(counts.running, 1);
  });
});
