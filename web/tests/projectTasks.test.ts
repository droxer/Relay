import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  laneExceptionStatus,
  projectTaskAssignee,
  projectTaskLanes,
  projectTaskProgress,
  projectTaskQueue,
} from "../src/lib/projectTasks.js";
import type { AgentTeam, EmployeeAgent, RelayTaskListItem } from "../src/types.js";

function task(overrides: Partial<RelayTaskListItem> & Pick<RelayTaskListItem, "id">): RelayTaskListItem {
  return {
    title: `Task ${overrides.id}`,
    description: "",
    priority: "normal",
    status: "backlog",
    isRoutine: false,
    routineEnabled: false,
    linkedSessionIds: [],
    createdAt: "2026-09-01T00:00:00Z",
    updatedAt: "2026-09-01T00:00:00Z",
    ...overrides,
  } as RelayTaskListItem;
}

function agent(overrides: Partial<EmployeeAgent> & Pick<EmployeeAgent, "id">): EmployeeAgent {
  return {
    supervisorEmployeeId: "employee-1",
    displayName: `Agent ${overrides.id}`,
    executorKind: "claude",
    skillPolicy: {},
    toolPolicy: {},
    modelPolicy: {},
    enabled: true,
    version: 1,
    availability: "ready",
    placements: [],
    createdAt: "2026-09-01T00:00:00Z",
    updatedAt: "2026-09-01T00:00:00Z",
    ...overrides,
  } as EmployeeAgent;
}

function team(overrides: Partial<AgentTeam> & Pick<AgentTeam, "id">): AgentTeam {
  return {
    ownerEmployeeId: "employee-1",
    name: `Team ${overrides.id}`,
    memberAgentIds: [],
    enabled: true,
    members: [],
    createdAt: "2026-09-01T00:00:00Z",
    updatedAt: "2026-09-01T00:00:00Z",
    ...overrides,
  } as AgentTeam;
}

describe("projectTaskQueue", () => {
  it("keeps only the project's live, non-routine tasks", () => {
    const queue = projectTaskQueue(
      [
        task({ id: "mine" , projectId: "p1" }),
        task({ id: "other", projectId: "p2" }),
        task({ id: "loose" }),
        task({ id: "routine", projectId: "p1", isRoutine: true }),
        task({ id: "gone", projectId: "p1", deletedAt: "2026-09-02T00:00:00Z" }),
      ],
      "p1",
    );
    assert.deepEqual(queue.map((entry) => entry.id), ["mine"]);
  });

  it("orders by the shared task queue comparator", () => {
    const queue = projectTaskQueue(
      [
        task({ id: "low", projectId: "p1", priority: "low" }),
        task({ id: "high", projectId: "p1", priority: "high" }),
        task({ id: "normal", projectId: "p1", priority: "normal" }),
      ],
      "p1",
    );
    assert.deepEqual(queue.map((entry) => entry.id), ["high", "normal", "low"]);
  });
});

describe("projectTaskLanes", () => {
  it("returns every stage, in board order, even when empty", () => {
    const lanes = projectTaskLanes([task({ id: "a", projectId: "p1", status: "review" })]);
    assert.deepEqual(lanes.map((lane) => lane.stage), ["backlog", "assigned", "running", "review", "done"]);
    assert.deepEqual(lanes.find((lane) => lane.stage === "review")?.tasks.map((entry) => entry.id), ["a"]);
  });

  it("files a blocked task under the running lane its stage names", () => {
    const lanes = projectTaskLanes([task({ id: "blocked", projectId: "p1", status: "blocked" })]);
    assert.deepEqual(lanes.find((lane) => lane.stage === "running")?.tasks.map((entry) => entry.id), ["blocked"]);
  });
});

describe("laneExceptionStatus", () => {
  it("is null when the lane already says what the status says", () => {
    assert.equal(laneExceptionStatus(task({ id: "a", status: "review" })), null);
    assert.equal(laneExceptionStatus(task({ id: "b", status: "done" })), null);
  });

  it("names the status the lane cannot show", () => {
    assert.equal(laneExceptionStatus(task({ id: "a", status: "blocked" })), "blocked");
    assert.equal(laneExceptionStatus(task({ id: "b", status: "waiting_for_human" })), "waiting_for_human");
  });
});

describe("projectTaskProgress", () => {
  it("counts completion and the work that needs a human", () => {
    const progress = projectTaskProgress([
      task({ id: "a", status: "done" }),
      task({ id: "b", status: "blocked" }),
      task({ id: "c", status: "waiting_for_human" }),
      task({ id: "d", status: "running" }),
    ]);
    assert.deepEqual(progress, { done: 1, total: 4, attention: 2, percent: 25 });
  });

  it("reports an empty project as zero rather than NaN", () => {
    assert.deepEqual(projectTaskProgress([]), { done: 0, total: 0, attention: 0, percent: 0 });
  });
});

describe("projectTaskAssignee", () => {
  const agents = [agent({ id: "agent-1", displayName: "Ada" })];
  const teams = [team({ id: "team-1", name: "Platform" })];

  it("names the assigned agent", () => {
    assert.deepEqual(
      projectTaskAssignee(task({ id: "a", assignedAgentId: "agent-1" }), agents, teams),
      { kind: "agent", name: "Ada" },
    );
  });

  it("prefers the team when the task carries one", () => {
    assert.deepEqual(
      projectTaskAssignee(
        task({ id: "a", assignedTeamId: "team-1", assignedAgentId: "agent-1" }),
        agents,
        teams,
      ),
      { kind: "team", name: "Platform" },
    );
  });

  it("never leaks a raw id for an agent that has left the roster", () => {
    assert.deepEqual(
      projectTaskAssignee(task({ id: "a", assignedAgentId: "ghost" }), agents, teams),
      { kind: "agent-missing" },
    );
  });

  it("never leaks a raw id for a team that has left the roster", () => {
    assert.deepEqual(
      projectTaskAssignee(task({ id: "a", assignedTeamId: "ghost" }), agents, teams),
      { kind: "team-missing" },
    );
  });

  it("reports an unassigned task as unassigned", () => {
    assert.deepEqual(projectTaskAssignee(task({ id: "a" }), agents, teams), { kind: "unassigned" });
  });
});
