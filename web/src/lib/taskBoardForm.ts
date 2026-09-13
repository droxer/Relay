import type { AgentName, CurrentUser, TaskPriority, TaskRoutineCadence, TaskRoutineType, TaskStatus } from "../types.js";

export type TaskBoardFormBase = {
  id?: string;
  title: string;
  description: string;
  priority: TaskPriority;
  assigneeEmployeeId: string;
  assignedAgent: "" | AgentName;
  assignedAgentId?: string;
  assignedTeamId?: string;
  acceptancePolicy?: "human" | "automatic";
  startedAt?: string;
};

export type BacklogTaskFormState = TaskBoardFormBase & {
  variant: "backlog";
  status: TaskStatus;
  dueDate: string;
};

export type RoutineTaskFormState = TaskBoardFormBase & {
  variant: "routine";
  routineType: TaskRoutineType;
  routineCadence: TaskRoutineCadence;
  routineNextRunDate: string;
  routineEnabled: boolean;
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

export function emptyRoutineForm(currentUser: CurrentUser, date = new Date()): RoutineTaskFormState {
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
    routineType: "task",
    routineCadence: "weekly",
    routineNextRunDate: nextRoutineRunDate("weekly", date),
    routineEnabled: false,
  };
}

export function nextRoutineRunDate(cadence: TaskRoutineCadence, date = new Date()): string {
  const next = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  if (cadence === "custom") return "";
  if (cadence === "daily") next.setDate(next.getDate() + 1);
  else if (cadence === "weekly") next.setDate(next.getDate() + 7);
  else {
    const targetMonth = next.getMonth() + 1;
    const lastDay = new Date(next.getFullYear(), targetMonth + 1, 0).getDate();
    next.setDate(Math.min(next.getDate(), lastDay));
    next.setMonth(targetMonth);
  }
  return localDateKey(next);
}

export function taskBoardFormsEqual(a: TaskBoardFormState, b: TaskBoardFormState): boolean {
  if (a.variant !== b.variant) return false;
  if (
    a.id !== b.id
    || a.title !== b.title
    || a.description !== b.description
    || a.priority !== b.priority
    || a.assigneeEmployeeId !== b.assigneeEmployeeId
    || a.assignedAgent !== b.assignedAgent
    || a.assignedAgentId !== b.assignedAgentId
    || a.assignedTeamId !== b.assignedTeamId
    || a.acceptancePolicy !== b.acceptancePolicy
  ) {
    return false;
  }
  if (a.variant === "backlog" && b.variant === "backlog") {
    return a.status === b.status && a.dueDate === b.dueDate;
  }
  if (a.variant === "routine" && b.variant === "routine") {
    return a.routineType === b.routineType
      && a.routineCadence === b.routineCadence
      && a.routineNextRunDate === b.routineNextRunDate
      && a.routineEnabled === b.routineEnabled;
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
    return { ...cleared, routineEnabled: false };
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

function localDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
