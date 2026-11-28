import type {
  AgentName, CollaborationStyle, CurrentUser, RelayTaskListItem, RoutinePauseReason, RoutineState, RoutineTrigger,
  TaskMutationInput, TaskPriority, TaskStatus,
} from "../types.js";
import type { TaskPermissionMode } from "relay-core";

import { defaultSchedule } from "./automationSchedule.ts";
import { normalizeTriggerForSave, triggersEqual, triggersOf } from "./automationTrigger.ts";
import { tagsEqual } from "./taskTags.ts";

export type AcceptancePolicy = "human" | "automatic";

/**
 * Mirrors backend/relay/tasks/flow.py: a new task waits for a person's
 * acceptance, while a task stored before the policy existed carries none and
 * always closed on its own — so reading a stored task falls back to that.
 */
export const NEW_TASK_ACCEPTANCE_POLICY: AcceptancePolicy = "human";
const LEGACY_ACCEPTANCE_POLICY: AcceptancePolicy = "automatic";

/** The policy the backend applies to a stored task. */
export function taskAcceptancePolicy(task: Pick<RelayTaskListItem, "acceptancePolicy">): AcceptancePolicy {
  return task.acceptancePolicy ?? LEGACY_ACCEPTANCE_POLICY;
}

export type TaskBoardFormBase = {
  connectionGrants?: import("../domain-types/connections.ts").ConnectionGrant[];
  id?: string;
  number?: number;
  projectId?: string;
  computerId?: string;
  sourceRoutineId?: string;
  title: string;
  description: string;
  priority: TaskPriority;
  tags: string[];
  assigneeUserId: string;
  assignedAgent: "" | AgentName;
  assignedAgentId?: string;
  assignedTeamId?: string;
  assignedWorkflowId?: string;
  acceptancePolicy?: AcceptancePolicy;
  permissionMode?: TaskPermissionMode;
  collaborationStyle?: CollaborationStyle | null;
  startedAt?: string;
};

export type BacklogTaskFormState = TaskBoardFormBase & {
  variant: "backlog";
  status: TaskStatus;
  dueDate: string;
};

export type RoutineTaskFormState = TaskBoardFormBase & {
  variant: "routine";
  routineTriggers: RoutineTrigger[];
  routineState: RoutineState;
  routinePauseReason?: RoutinePauseReason;
};

export type TaskBoardFormState = BacklogTaskFormState | RoutineTaskFormState;

export function emptyBacklogForm(currentUser: CurrentUser): BacklogTaskFormState {
  return {
    variant: "backlog",
    title: "",
    description: "",
    acceptancePolicy: NEW_TASK_ACCEPTANCE_POLICY,
    priority: "normal",
    tags: [],
    status: "backlog",
    dueDate: "",
    assigneeUserId: currentUser.userId ?? currentUser.username,
    assignedAgent: "",
    assignedAgentId: "",
    assignedTeamId: "",
    assignedWorkflowId: "",
  };
}

export function emptyRoutineForm(currentUser: CurrentUser): RoutineTaskFormState {
  return {
    variant: "routine",
    title: "",
    description: "",
    acceptancePolicy: NEW_TASK_ACCEPTANCE_POLICY,
    priority: "normal",
    tags: [],
    assigneeUserId: currentUser.userId ?? currentUser.username,
    assignedAgent: "",
    assignedAgentId: "",
    assignedTeamId: "",
    routineTriggers: [{ kind: "schedule", schedule: defaultSchedule() }],
    routineState: "paused",
  };
}

/** The automation half of an edit form, read from a saved task. */
export function routineFormFields(
  task: Pick<RelayTaskListItem, "routineTriggers" | "routineState" | "routinePauseReason">,
): Pick<RoutineTaskFormState, "routineTriggers" | "routineState" | "routinePauseReason"> {
  return {
    routineTriggers: triggersOf(task),
    routineState: task.routineState ?? "paused",
    ...(task.routineState === "paused_by_relay" && task.routinePauseReason ? { routinePauseReason: task.routinePauseReason } : {}),
  };
}

/**
 * The automation fields of a create or update body. A Relay pause is left
 * out: only the server sets it, and sending it back would be refused. The
 * owner resumes by switching the form to active.
 */
export function routineMutationFields(
  form: Pick<RoutineTaskFormState, "routineTriggers" | "routineState">,
  baseline?: Pick<RoutineTaskFormState, "routineTriggers" | "routineState"> | null,
): Pick<TaskMutationInput, "isRoutine" | "routineTriggers" | "routineState"> {
  const triggers = form.routineTriggers.map(normalizeTriggerForSave);
  const triggersChanged = !baseline || JSON.stringify(triggers) !== JSON.stringify(baseline.routineTriggers.map(normalizeTriggerForSave));
  return {
    isRoutine: true,
    ...(triggersChanged ? { routineTriggers: triggers } : {}),
    ...(form.routineState !== "paused_by_relay" && form.routineState !== baseline?.routineState ? { routineState: form.routineState } : {}),
  };
}

export function taskBoardFormsEqual(a: TaskBoardFormState, b: TaskBoardFormState): boolean {
  if (JSON.stringify(a.connectionGrants) !== JSON.stringify(b.connectionGrants)) return false;
  if (a.variant !== b.variant) return false;
  if (
    a.id !== b.id
    || a.projectId !== b.projectId
    || a.computerId !== b.computerId
    || a.title !== b.title
    || a.description !== b.description
    || a.priority !== b.priority
    || !tagsEqual(a.tags, b.tags)
    || a.assigneeUserId !== b.assigneeUserId
    || a.assignedAgent !== b.assignedAgent
    || a.assignedAgentId !== b.assignedAgentId
    || a.assignedTeamId !== b.assignedTeamId
    || a.assignedWorkflowId !== b.assignedWorkflowId
    || a.acceptancePolicy !== b.acceptancePolicy
    || (a.permissionMode ?? "ask") !== (b.permissionMode ?? "ask")
    || (a.collaborationStyle ?? null) !== (b.collaborationStyle ?? null)
  ) {
    return false;
  }
  if (a.variant === "backlog" && b.variant === "backlog") {
    return a.status === b.status && a.dueDate === b.dueDate;
  }
  if (a.variant === "routine" && b.variant === "routine") {
    return triggersEqual(a.routineTriggers, b.routineTriggers) && a.routineState === b.routineState;
  }
  return false;
}

export type TaskAssignmentSelection =
  | { kind: "none" }
  | { kind: "agent"; id: string }
  | { kind: "team"; id: string }
  | { kind: "workflow"; id: string; computerId?: string };

export function parseTaskAssignmentValue(value: string): TaskAssignmentSelection {
  if (value.startsWith("workflow:") && value.length > 9) return { kind: "workflow", id: value.slice(9) };
  if (value.startsWith("team:") && value.length > 5) {
    return { kind: "team", id: value.slice(5) };
  }
  if (value.startsWith("agent:") && value.length > 6) {
    return { kind: "agent", id: value.slice(6) };
  }
  return { kind: "none" };
}

export function taskAssignmentValue(form: TaskBoardFormState): string {
  if (form.assignedTeamId) return `team:${form.assignedTeamId}`;
  if (form.assignedAgentId) return `agent:${form.assignedAgentId}`;
  return "__none__";
}

export function taskAssignmentMutationFields(
  form: Pick<TaskBoardFormBase, "assignedAgentId" | "assignedTeamId" | "assignedWorkflowId">,
): { assignedAgentId: string | null; assignedTeamId: string | null; assignedWorkflowId?: string | null } {
  return {
    assignedAgentId: form.assignedAgentId || null,
    assignedTeamId: form.assignedTeamId || null,
    ...(form.assignedWorkflowId !== undefined ? { assignedWorkflowId: form.assignedWorkflowId || null } : {}),
  };
}

export function taskAssignmentUnchanged(form: TaskBoardFormState, baseline: TaskBoardFormState | null): boolean {
  return Boolean(form.id && baseline
    && form.projectId === baseline.projectId
    && form.assignedAgentId === baseline.assignedAgentId
    && form.assignedTeamId === baseline.assignedTeamId
    && form.assignedWorkflowId === baseline.assignedWorkflowId
    && form.collaborationStyle === baseline.collaborationStyle);
}

type TaskStartSelection = {
  id: string;
  assignedAgentId?: string;
  assignedTeamId?: string;
  assignedWorkflowId?: string;
};

function taskStartAssignments(task: TaskStartSelection): Array<{ agentId: string }> | undefined {
  if (task.assignedTeamId || !task.assignedAgentId) return undefined;
  return [{ agentId: task.assignedAgentId }];
}

export function taskStartMutationInput(
  task: TaskStartSelection,
  fallbackAssignments?: Array<{ agentId?: string; agent: AgentName }>,
): { taskId: string; assignments?: Array<{ agentId?: string; agent?: AgentName }> } {
  const selectedAssignments = taskStartAssignments(task);
  const assignments = selectedAssignments
    ?? (!task.assignedAgentId && !task.assignedTeamId && !task.assignedWorkflowId ? fallbackAssignments : undefined);
  return {
    taskId: task.id,
    ...(assignments ? { assignments } : {}),
  };
}

export function clearTaskAssignment(form: TaskBoardFormState): TaskBoardFormState {
  const cleared = {
    ...form,
    assignedAgent: "" as const,
    assignedAgentId: "",
    assignedTeamId: "",
    assignedWorkflowId: "",
  };
  if (cleared.variant === "routine") {
    return { ...cleared, routineState: "paused" };
  }
  return {
    ...cleared,
    status: (cleared.status === "assigned" || cleared.status === "queued") ? "backlog" : cleared.status,
  };
}

export function teamAssignmentPatch(teamId: string, workflowId = ""): Pick<
  TaskBoardFormBase,
  "assignedAgent" | "assignedAgentId" | "assignedTeamId" | "assignedWorkflowId"
> {
  return {
    assignedAgent: "",
    assignedAgentId: "",
    assignedTeamId: teamId,
    assignedWorkflowId: workflowId,
  };
}
