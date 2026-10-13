import type {
  AgentName, CollaborationStyle, CurrentUser, RelayTaskListItem, RoutinePauseReason, RoutineState, RoutineTrigger,
  TaskMutationInput, TaskPriority, TaskStatus,
} from "../types.js";

import { defaultSchedule } from "./automationSchedule.ts";
import { normalizeTriggerForSave, triggersEqual, triggersOf } from "./automationTrigger.ts";

export type TaskBoardFormBase = {
  id?: string;
  number?: number;
  projectId?: string;
  sourceRoutineId?: string;
  title: string;
  description: string;
  priority: TaskPriority;
  assigneeEmployeeId: string;
  assignedAgent: "" | AgentName;
  assignedAgentId?: string;
  assignedTeamId?: string;
  acceptancePolicy?: "human" | "automatic";
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
    acceptancePolicy: "human",
    priority: "normal",
    status: "backlog",
    dueDate: "",
    assigneeEmployeeId: currentUser.employeeId ?? currentUser.username,
    assignedAgent: "",
    assignedAgentId: "",
    assignedTeamId: "",
  };
}

export function emptyRoutineForm(currentUser: CurrentUser): RoutineTaskFormState {
  return {
    variant: "routine",
    title: "",
    description: "",
    acceptancePolicy: "human",
    priority: "normal",
    assigneeEmployeeId: currentUser.employeeId ?? currentUser.username,
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
): Pick<TaskMutationInput, "isRoutine" | "routineTriggers" | "routineState"> {
  return {
    isRoutine: true,
    routineTriggers: form.routineTriggers.map(normalizeTriggerForSave),
    ...(form.routineState === "paused_by_relay" ? {} : { routineState: form.routineState }),
  };
}

export function taskBoardFormsEqual(a: TaskBoardFormState, b: TaskBoardFormState): boolean {
  if (a.variant !== b.variant) return false;
  if (
    a.id !== b.id
    || a.projectId !== b.projectId
    || a.title !== b.title
    || a.description !== b.description
    || a.priority !== b.priority
    || a.assigneeEmployeeId !== b.assigneeEmployeeId
    || a.assignedAgent !== b.assignedAgent
    || a.assignedAgentId !== b.assignedAgentId
    || a.assignedTeamId !== b.assignedTeamId
    || a.acceptancePolicy !== b.acceptancePolicy
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
  | { kind: "team"; id: string };

export function parseTaskAssignmentValue(value: string): TaskAssignmentSelection {
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
  form: Pick<TaskBoardFormBase, "assignedAgentId" | "assignedTeamId">,
): { assignedAgentId: string | null; assignedTeamId: string | null } {
  return {
    assignedAgentId: form.assignedAgentId || null,
    assignedTeamId: form.assignedTeamId || null,
  };
}

type TaskStartSelection = {
  id: string;
  assignedAgentId?: string;
  assignedTeamId?: string;
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
    ?? (!task.assignedAgentId && !task.assignedTeamId ? fallbackAssignments : undefined);
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
  };
  if (cleared.variant === "routine") {
    return { ...cleared, routineState: "paused" };
  }
  return {
    ...cleared,
    status: cleared.status === "assigned" ? "backlog" : cleared.status,
  };
}

export function teamAssignmentPatch(teamId: string): Pick<
  TaskBoardFormBase,
  "assignedAgent" | "assignedAgentId" | "assignedTeamId"
> {
  return {
    assignedAgent: "",
    assignedAgentId: "",
    assignedTeamId: teamId,
  };
}
