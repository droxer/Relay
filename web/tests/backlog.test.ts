import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { agentReadyForTask, canDiscussTask, discussionAgentsForTask, dueTone, filterTasks, localDateKey, tasksByStatus, type BacklogFilters } from "../src/lib/backlog.js";
import type { DaemonNodeMonitorRecord, EmployeeAgent, RelayTask } from "../src/types.js";

const baseFilters: BacklogFilters = {
  query: "",
  status: "all",
  priority: "all",
  agent: "all",
  team: "all",
  assignment: "all",
  assignee: "",
  due: "all",
  source: "all",
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
    sourceRoutineId: input.sourceRoutineId,
    scheduledFor: input.scheduledFor,
    assignedAgent: input.assignedAgent,
    assignedAgentId: input.assignedAgentId,
    assignedTeamId: input.assignedTeamId,
    linkedSessionIds: input.linkedSessionIds ?? [],
    activity: input.activity ?? [],
    createdAt: input.createdAt ?? "2026-06-01T00:00:00.000Z",
    updatedAt: input.updatedAt ?? "2026-06-01T00:00:00.000Z",
    events: input.events ?? [],
  } as RelayTask;
}

function node(input: Partial<DaemonNodeMonitorRecord> & { id: string }): DaemonNodeMonitorRecord {
  return {
    id: input.id,
    employeeId: input.employeeId ?? "alice",
    status: input.status ?? "ready",
    online: input.online ?? true,
    agents: input.agents ?? { claude: "ready", pi: "ready", codex: "ready", kimi: "ready" },
    disabledAgents: input.disabledAgents,
    maxConcurrentRuns: input.maxConcurrentRuns,
    activeRuns: input.activeRuns ?? [],
    queuedCommandCount: input.queuedCommandCount ?? 0,
    stale: input.stale ?? false,
    createdAt: input.createdAt ?? "2026-06-01T00:00:00.000Z",
    updatedAt: input.updatedAt ?? "2026-06-01T00:00:00.000Z",
  } as DaemonNodeMonitorRecord;
}

describe("filterTasks source", () => {
  const direct = task({ id: "own", title: "Migrate the auth store" });
  const occurrence = task({ id: "occ", title: "Weekly status deck", sourceRoutineId: "routine_1" });

  it("shows both a person's tasks and routine occurrences by default", () => {
    // An occurrence is real work someone may have to act on, so the board does
    // not hide it — the badge on the record is what supplies the provenance.
    const result = filterTasks([direct, occurrence], baseFilters);
    assert.deepEqual(result.map((item) => item.id).sort(), ["occ", "own"]);
  });

  it("narrows to tasks nobody's routine generated", () => {
    const result = filterTasks([direct, occurrence], { ...baseFilters, source: "direct" });
    assert.deepEqual(result.map((item) => item.id), ["own"]);
  });

  it("narrows to routine occurrences", () => {
    const result = filterTasks([direct, occurrence], { ...baseFilters, source: "routine" });
    assert.deepEqual(result.map((item) => item.id), ["occ"]);
  });

  it("never lets a routine definition through, whatever the source filter says", () => {
    // The routines page owns definitions; the board only ever shows runs.
    const routine = task({ id: "def", title: "Weekly status deck", isRoutine: true });
    for (const source of ["all", "direct", "routine"] as const) {
      const result = filterTasks([routine], { ...baseFilters, source });
      assert.deepEqual(result, []);
    }
  });
});

describe("filterTasks", () => {
  it("filters by status priority agent assignee and due state", () => {
    const tasks = [
      task({ id: "a", title: "Ship board", status: "assigned", priority: "high", assignedAgent: "codex", assignedAgentId: "agent_builder", assigneeEmployeeId: "alice", dueDate: "2026-06-20" }),
      task({ id: "b", title: "Polish copy", status: "backlog", priority: "low", assignedAgent: "claude", assigneeEmployeeId: "bob", dueDate: "2026-06-26" }),
    ];

    const result = filterTasks(tasks, {
      ...baseFilters,
      query: "ship",
      status: "assigned",
      priority: "high",
      agent: "agent_builder",
      assignee: "ali",
      due: "overdue",
    }, "2026-06-24");

    assert.deepEqual(result.map((item) => item.id), ["a"]);
  });

  it("groups every task status", () => {
    const grouped = tasksByStatus([
      task({ id: "a", title: "A", status: "backlog" }),
      task({ id: "b", title: "B", status: "done" }),
    ]);

    assert.equal(grouped.backlog.length, 1);
    assert.equal(grouped.done.length, 1);
    assert.equal(grouped.running.length, 0);
  });

  it("excludes routine definitions from the backlog", () => {
    const result = filterTasks([
      task({ id: "work", title: "One-off work" }),
      task({ id: "routine", title: "Weekly report", isRoutine: true }),
    ], baseFilters);

    assert.deepEqual(result.map((item) => item.id), ["work"]);
  });
});

describe("agentReadyForTask", () => {
  it("does not treat legacy executor/node state as a named-agent assignment", () => {
    const backlogTask = task({ id: "a", title: "A", assignedAgent: "codex", assigneeEmployeeId: "alice" });

    assert.equal(agentReadyForTask(backlogTask, [node({ id: "n1", employeeId: "alice" })]), false);
    assert.equal(agentReadyForTask(backlogTask, [node({ id: "n2", employeeId: "bob" })]), false);
    assert.equal(agentReadyForTask(backlogTask, [node({ id: "n3", employeeId: "alice", disabledAgents: ["codex"] })]), false);
    assert.equal(agentReadyForTask(backlogTask, [node({
      id: "n4",
      employeeId: "alice",
      status: "running",
      activeRuns: [{ commandId: "cmd_1", sessionId: "ses_1", runId: "run_1", agent: "codex", taskGoal: "question", startedAt: "2026-06-28T00:00:00.000Z" }],
    })]), false);
  });

  it("uses logical-agent availability instead of employee node ownership", () => {
    const backlogTask = task({ id: "a", title: "A", assignedAgent: "codex", assignedAgentId: "agent_builder" });
    const logicalAgent: EmployeeAgent = {
      id: "agent_builder",
      supervisorEmployeeId: "alice",
      displayName: "Builder",
      executorKind: "codex",
      skillPolicy: {}, toolPolicy: {}, modelPolicy: {},
      enabled: true,
      version: 1,
      availability: "ready",
      placements: [],
      createdAt: "2026-07-10T00:00:00.000Z",
      updatedAt: "2026-07-10T00:00:00.000Z",
    };

    assert.equal(agentReadyForTask(backlogTask, [], [logicalAgent]), true);
    assert.equal(agentReadyForTask(backlogTask, [node({ id: "n1", employeeId: "alice" })], [{ ...logicalAgent, availability: "offline" }]), false);
  });
});

describe("discussionAgentsForTask", () => {
  it("does not offer the implicit all-agent discussion for a named Team task", () => {
    assert.equal(canDiscussTask(task({ id: "team", title: "Team work", assignedTeamId: "team_delivery" })), false);
    assert.equal(canDiscussTask(task({ id: "agent", title: "Agent work", assignedAgentId: "agent_builder" })), true);
    assert.equal(canDiscussTask(task({ id: "open", title: "Open discussion" })), true);
  });

  it("uses ready logical agents without exposing their runtime nodes", () => {
    const backlogTask = task({ id: "a", title: "A", assigneeEmployeeId: "alice" });
    const base: Omit<EmployeeAgent, "id" | "displayName" | "executorKind"> = {
      supervisorEmployeeId: "alice", skillPolicy: {}, toolPolicy: {}, modelPolicy: {},
      enabled: true, version: 1, availability: "ready", placements: [],
      createdAt: "2026-07-10T00:00:00.000Z", updatedAt: "2026-07-10T00:00:00.000Z",
    };
    assert.deepEqual(discussionAgentsForTask(backlogTask, [], [
      { ...base, id: "agent_research", displayName: "Researcher", executorKind: "claude" },
      { ...base, id: "agent_review", displayName: "Reviewer", executorKind: "claude" },
      { ...base, id: "agent_build", displayName: "Builder", executorKind: "codex" },
    ]), ["claude", "codex"]);
  });

  it("does not synthesize employee-facing agents from daemon nodes", () => {
    const backlogTask = task({ id: "a", title: "A", assigneeEmployeeId: "alice" });

    assert.deepEqual(discussionAgentsForTask(backlogTask, [
      node({ id: "n1", employeeId: "bob" }),
      node({ id: "n2", employeeId: "alice", agents: { claude: "ready", pi: "failed", codex: "ready", kimi: "unknown" }, disabledAgents: ["codex"] }),
    ]), []);
  });
});

describe("dueTone", () => {
  it("marks overdue and today due dates", () => {
    assert.equal(dueTone(task({ id: "a", title: "A", dueDate: "2026-06-23" }), "2026-06-24"), "bad");
    assert.equal(dueTone(task({ id: "b", title: "B", dueDate: "2026-06-24" }), "2026-06-24"), "warn");
    assert.equal(dueTone(task({ id: "c", title: "C", dueDate: "2026-06-23", status: "done" }), "2026-06-24"), "neutral");
  });
});

describe("localDateKey", () => {
  it("uses the user's local calendar day instead of UTC", () => {
    assert.equal(localDateKey(new Date(2026, 5, 24, 0, 30)), "2026-06-24");
  });
});

describe("task executor and upcoming filters", () => {
  const work = [
    task({ id: "none", title: "None" }),
    task({ id: "agent", title: "Agent", assignedAgentId: "a" }),
    task({ id: "team", title: "Team", assignedTeamId: "t" }),
    task({ id: "legacy", title: "Legacy", assignedAgent: "codex" }),
  ];
  it("distinguishes unassigned tasks from agent, team, and legacy assignments", () => {
    assert.deepEqual(filterTasks(work, { ...baseFilters, assignment: "unassigned" }).map((task) => task.id), ["none"]);
    assert.equal(filterTasks(work, { ...baseFilters, assignment: "assigned" }).length, 3);
    assert.deepEqual(filterTasks(work, { ...baseFilters, team: "t", assignment: "assigned" }).map((task) => task.id), ["team"]);
  });
  it("uses a seven-calendar-day window starting today, excluding completed and undated tasks", () => {
    const due = [
      task({ id: "past", title: "Past", dueDate: "2026-09-20" }),
      task({ id: "today", title: "Today", dueDate: "2026-09-21" }),
      task({ id: "last", title: "Last", dueDate: "2026-09-27" }),
      task({ id: "outside", title: "Outside", dueDate: "2026-09-28" }),
      task({ id: "done", title: "Done", dueDate: "2026-09-22", status: "done" }),
      task({ id: "undated", title: "Undated" }),
    ];
    assert.deepEqual(filterTasks(due, { ...baseFilters, due: "next_week" }, "2026-09-21").map((task) => task.id), ["today", "last"]);
  });
});
