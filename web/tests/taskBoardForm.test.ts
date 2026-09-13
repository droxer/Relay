import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  clearTaskAssignment,
  emptyBacklogForm,
  emptyRoutineForm,
  nextRoutineRunDate,
  parseTaskAssignmentValue,
  taskStartMutationInput,
  teamAssignmentPatch,
  taskAssignmentMutationFields,
  taskAssignmentValue,
  taskBoardFormsEqual,
  type BacklogTaskFormState,
  type RoutineTaskFormState,
} from "../src/lib/taskBoardForm.js";
import { parseAppPath, pathForAppState } from "../src/lib/appRoute.js";
import { assignmentOptionVisible } from "../src/lib/taskAssignment.js";

describe("taskBoardForm", () => {
  const user = { id: "user-alice", username: "alice", employeeId: "alice", role: "user" as const };

  it("detects equal backlog forms", () => {
    const a = emptyBacklogForm(user);
    const b = { ...a, title: "Ship backlog polish" };
    assert.equal(taskBoardFormsEqual(a, a), true);
    assert.equal(taskBoardFormsEqual(a, b), false);
  });

  it("detects equal routine forms", () => {
    const a = emptyRoutineForm(user, new Date(2026, 6, 7, 9));
    const b: RoutineTaskFormState = { ...a, routineCadence: "daily" };
    assert.equal(a.routineNextRunDate, "2026-07-14");
    assert.equal(taskBoardFormsEqual(a, a), true);
    assert.equal(taskBoardFormsEqual(a, b), false);
  });

  it("calculates the next run from cadence", () => {
    const today = new Date(2026, 0, 31, 9);
    assert.equal(nextRoutineRunDate("daily", today), "2026-02-01");
    assert.equal(nextRoutineRunDate("weekly", today), "2026-02-07");
    assert.equal(nextRoutineRunDate("monthly", today), "2026-02-28");
    assert.equal(nextRoutineRunDate("custom", today), "");
  });

  it("rejects mixed variants", () => {
    const backlog: BacklogTaskFormState = emptyBacklogForm(user);
    const routine: RoutineTaskFormState = emptyRoutineForm(user);
    assert.equal(taskBoardFormsEqual(backlog, routine), false);
  });

  it("tracks team assignment changes and parses picker values", () => {
    const base = emptyBacklogForm(user);
    const assigned = { ...base, assignedTeamId: "team_delivery" };

    assert.equal(taskBoardFormsEqual(base, assigned), false);
    assert.equal(taskAssignmentValue(assigned), "team:team_delivery");
    assert.deepEqual(parseTaskAssignmentValue("team:team_delivery"), {
      kind: "team",
      id: "team_delivery",
    });
    assert.deepEqual(parseTaskAssignmentValue("agent:agent_builder"), {
      kind: "agent",
      id: "agent_builder",
    });
    assert.deepEqual(teamAssignmentPatch("team_delivery"), {
      assignedAgent: "",
      assignedAgentId: "",
      assignedTeamId: "team_delivery",
    });
  });

  it("maps team assignments into backlog and routine API payload fields", () => {
    const backlog = { ...emptyBacklogForm(user), ...teamAssignmentPatch("team_delivery") };
    const routine = { ...emptyRoutineForm(user), ...teamAssignmentPatch("team_ops") };

    assert.deepEqual(taskAssignmentMutationFields(backlog), {
      assignedAgentId: null,
      assignedTeamId: "team_delivery",
    });
    assert.deepEqual(taskAssignmentMutationFields(routine), {
      assignedAgentId: null,
      assignedTeamId: "team_ops",
    });
  });

  it("pins a task start request to its selected logical agent", () => {
    assert.deepEqual(
      taskStartMutationInput({
        id: "task_1",
        assignedAgentId: "agent_selected",
      }),
      {
        taskId: "task_1",
        assignments: [{ agentId: "agent_selected" }],
      },
    );
    assert.deepEqual(
      taskStartMutationInput({
        id: "task_2",
        assignedTeamId: "team_delivery",
      }),
      { taskId: "task_2" },
    );
  });

  it("offers ownerless assignment options to every assignee", () => {
    // Agents and teams are not always employee-scoped: an ownerless record is
    // globally assignable, mirroring the backend's "ownerless legacy sessions
    // are allowed" rule. Filtering them out emptied the picker entirely.
    assert.equal(assignmentOptionVisible(undefined, "alice", false), true);
    assert.equal(assignmentOptionVisible("", "alice", false), true);
    assert.equal(assignmentOptionVisible(undefined, "alice", true), true);
    assert.equal(assignmentOptionVisible("alice", "alice", false), true);
    assert.equal(assignmentOptionVisible("bob", "alice", false), false);
  });

  it("returns an unassigned assigned task to backlog", () => {
    const form = {
      ...emptyBacklogForm(user),
      status: "assigned" as const,
      assignedAgentId: "agent-1",
    };

    assert.deepEqual(clearTaskAssignment(form), {
      ...form,
      status: "backlog",
      assignedAgent: "",
      assignedAgentId: "",
      assignedTeamId: "",
    });
  });
});

describe("appRoute path parsing", () => {
  it("maps work routes and thread sessions", () => {
    assert.deepEqual(parseAppPath("/backlog"), {
      route: "backlog",
      mobileView: "chat",
      sessionId: null,
    });
    assert.deepEqual(parseAppPath("/threads/sess-1"), {
      route: "main",
      mobileView: "chat",
      sessionId: "sess-1",
    });
    assert.equal(pathForAppState({ route: "routine", mobileView: "chat", sessionId: null }), "/routines");
  });
});
