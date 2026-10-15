import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  clearTaskAssignment,
  emptyBacklogForm,
  emptyRoutineForm,
  routineFormFields,
  routineMutationFields,
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
  const user = { id: "user-alice", username: "alice", userId: "alice", role: "user" as const };

  it("detects equal backlog forms", () => {
    const a = emptyBacklogForm(user);
    const b = { ...a, title: "Ship backlog polish" };
    assert.equal(taskBoardFormsEqual(a, a), true);
    assert.equal(taskBoardFormsEqual(a, b), false);
  });

  it("detects equal routine forms", () => {
    const a = emptyRoutineForm(user);
    const b: RoutineTaskFormState = { ...a, routineState: "active" };
    assert.equal(taskBoardFormsEqual(a, a), true);
    assert.equal(taskBoardFormsEqual(a, b), false);
  });

  it("sends only v2 automation fields", () => {
    const form = { ...emptyRoutineForm(user), routineState: "active" as const };
    const body = routineMutationFields(form);
    assert.deepEqual(body.routineTriggers, form.routineTriggers);
    assert.equal(body.routineState, "active");
    assert.equal(body.isRoutine, true);
    for (const legacy of ["routineType", "routineCadence", "routineNextRunDate", "routineEnabled", "routineTrigger", "routineDisabledReason"]) {
      assert.equal(legacy in body, false, legacy);
    }
  });

  it("leaves a Relay pause for the server to keep", () => {
    const body = routineMutationFields({ routineTriggers: [], routineState: "paused_by_relay" });
    assert.equal("routineState" in body, false);
    assert.deepEqual(body.routineTriggers, []);
  });

  it("reads the automation fields of a saved task", () => {
    assert.deepEqual(routineFormFields({ routineTriggers: [{ kind: "webhook" }], routineState: "paused_by_relay", routinePauseReason: "failing" }),
      { routineTriggers: [{ kind: "webhook" }], routineState: "paused_by_relay", routinePauseReason: "failing" });
    assert.deepEqual(routineFormFields({}), { routineTriggers: [], routineState: "paused" });
  });

  it("pauses an automation whose assignment is cleared", () => {
    const form = { ...emptyRoutineForm(user), routineState: "active" as const, assignedAgentId: "a" };
    const cleared = clearTaskAssignment(form);
    assert.equal(cleared.variant === "routine" && cleared.routineState, "paused");
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
    // Agents and teams are not always user-scoped: an ownerless record is
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
    assert.equal(pathForAppState({ route: "routine", mobileView: "chat", sessionId: null }), "/automations");
  });
});

it("defaults to a paused weekday schedule and detects changed triggers", () => {
  const form = emptyRoutineForm({ id: "u", username: "u", role: "user" });
  assert.equal(form.routineState, "paused");
  assert.equal(form.routineTriggers.length, 1);
  const [trigger] = form.routineTriggers;
  assert.deepEqual(trigger.kind === "schedule" && trigger.schedule.repeat, { every: "weekday", at: "09:00" });
  assert.equal(taskBoardFormsEqual(form, { ...form, routineTriggers: [{ kind: "webhook" }] }), false);
  assert.equal(taskBoardFormsEqual(form, { ...form, routineTriggers: [] }), false);
});
