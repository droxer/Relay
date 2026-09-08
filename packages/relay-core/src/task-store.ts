import { newRelayId, nowIso } from "./session-store.js";
import type { AgentName } from "./state.js";

export type TaskPriority = "low" | "normal" | "high";
export type TaskStatus = "backlog" | "assigned" | "running" | "waiting_for_human" | "review" | "done" | "blocked";
export type TaskRoutineType = "task" | "job";
export type TaskRoutineCadence = "daily" | "weekly" | "monthly" | "custom";

export interface RelayTaskActivity {
  id: string;
  createdAt: string;
  message: string;
  agent?: AgentName;
  sessionId?: string;
}

export interface TaskWorkspaceBinding {
  computerId: string;
  workspaceRoot?: string;
  layout: "node-root" | "thread" | "task" | "project";
  subpath?: string | null;
  sessionId?: string;
}

export interface RelayTask {
  id: string;
  title: string;
  description: string;
  priority: TaskPriority;
  status: TaskStatus;
  /** Employee who owns this task; their agent carries it out on their behalf. */
  ownerEmployeeId?: string;
  /** Project whose conversations and workspace contain this task. */
  projectId?: string;
  /** Human assignee responsible for the backlog item. */
  assigneeEmployeeId?: string;
  /** Date-only due date in YYYY-MM-DD format. */
  dueDate?: string;
  isRoutine: boolean;
  routineType?: TaskRoutineType;
  routineCadence?: TaskRoutineCadence;
  /** Date-only next routine run date in YYYY-MM-DD format. */
  routineNextRunDate?: string;
  routineEnabled: boolean;
  /** Parent routine for a generated occurrence. */
  sourceRoutineId?: string;
  /** Calendar date this occurrence was generated for. */
  scheduledFor?: string;
  /** Generated occurrence tasks, in creation order. */
  occurrenceIds?: string[];
  assignedAgent?: AgentName;
  assignedAgentId?: string;
  /** Named team responsible for dispatching this task through its lead agent. */
  assignedTeamId?: string;
  dispatchClaim?: { id: string; claimedAt: string; expiresAt: string };
  dispatchOutcome?: {
    state: "started" | "queued" | "rejected";
    code?: string;
    message?: string;
  };
  workspaceBinding?: TaskWorkspaceBinding;
  workspaceWaiting?: { runId: string; sessionId: string; blockingSessionId?: string };
  linkedSessionIds: string[];
  activity: RelayTaskActivity[];
  createdAt: string;
  updatedAt: string;
  /** Set when a task.deleted event has been recorded; deleted tasks are hidden from lists. */
  deletedAt?: string;
  events: RelayTaskEvent[];
}

/** Materialized task fields shared by full records and list projections. */
export type RelayTaskListItem = Omit<RelayTask, "events" | "activity"> & {
  lastActivity?: RelayTaskActivity;
};

/** Task-list API projection with authoritative history counts. */
export type RelayTaskSummary = RelayTaskListItem & {
  eventCount: number;
  activityCount: number;
};

export type RelayTaskEvent =
  | {
      id: string;
      type: "task.workspace_wait";
      taskId: string;
      timestamp: string;
      runId: string;
      waiting: RelayTask["workspaceWaiting"] | null;
    }
  | {
      id: string;
      type: "task.workspace_bound";
      taskId: string;
      timestamp: string;
      binding: TaskWorkspaceBinding;
    }
  | {
      id: string;
      type: "task.created";
      taskId: string;
      timestamp: string;
      title: string;
      description: string;
      priority: TaskPriority;
      ownerEmployeeId?: string;
      projectId?: string;
      assigneeEmployeeId?: string;
      dueDate?: string;
      isRoutine?: boolean;
      routineType?: TaskRoutineType;
      routineCadence?: TaskRoutineCadence;
      routineNextRunDate?: string;
      routineEnabled?: boolean;
      sourceRoutineId?: string;
      scheduledFor?: string;
    }
  | {
      id: string;
      type: "task.updated";
      taskId: string;
      timestamp: string;
      title?: string;
      description?: string;
      priority?: TaskPriority;
      assigneeEmployeeId?: string;
      dueDate?: string;
      isRoutine?: boolean;
      routineType?: TaskRoutineType;
      routineCadence?: TaskRoutineCadence;
      routineNextRunDate?: string;
      routineEnabled?: boolean;
    }
  | {
      id: string;
      type: "task.assigned";
      taskId: string;
      timestamp: string;
      agent: AgentName;
      agentId?: string;
    }
  | {
      id: string;
      type: "task.assigned";
      taskId: string;
      timestamp: string;
      teamId: string;
    }
  | {
      id: string;
      type: "task.unassigned";
      taskId: string;
      timestamp: string;
    }
  | {
      id: string;
      type: "task.dispatch_claimed";
      taskId: string;
      timestamp: string;
      claim: { id: string; claimedAt: string; expiresAt: string };
    }
  | {
      id: string;
      type: "task.dispatch_released";
      taskId: string;
      timestamp: string;
      claimId: string;
    }
  | {
      id: string;
      type: "task.dispatch_outcome";
      taskId: string;
      timestamp: string;
      outcome: {
        state: "started" | "queued" | "rejected";
        code?: string;
        message?: string;
      };
    }
  | {
      id: string;
      type: "task.occurrence_created";
      taskId: string;
      timestamp: string;
      occurrenceId: string;
      scheduledFor: string;
    }
  | {
      id: string;
      type: "task.status";
      taskId: string;
      timestamp: string;
      status: TaskStatus;
      reason?: string;
    }
  | {
      id: string;
      type: "task.deleted";
      taskId: string;
      timestamp: string;
    }
  | {
      id: string;
      type: "task.session_linked";
      taskId: string;
      timestamp: string;
      sessionId: string;
    }
  | {
      id: string;
      type: "task.session_unlinked";
      taskId: string;
      timestamp: string;
      sessionId: string;
    }
  | {
      id: string;
      type: "task.activity";
      taskId: string;
      timestamp: string;
      activity: RelayTaskActivity;
    };

export function relayTaskEvent<T extends RelayTaskEvent["type"]>(
  type: T,
  taskId: string,
  payload: RelayTaskEventPayload<T>,
): Extract<RelayTaskEvent, { type: T }> {
  return {
    id: newRelayId("evt"),
    type,
    taskId,
    timestamp: nowIso(),
    ...(payload as object),
  } as Extract<RelayTaskEvent, { type: T }>;
}

type RelayTaskEventPayload<T extends RelayTaskEvent["type"]> =
  Extract<RelayTaskEvent, { type: T }> extends infer Event
    ? Event extends RelayTaskEvent
      ? Omit<Event, "id" | "type" | "taskId" | "timestamp">
      : never
    : never;

export function materializeTaskEvents(events: RelayTaskEvent[]): RelayTask {
  const created = events.find((event): event is Extract<RelayTaskEvent, { type: "task.created" }> => event.type === "task.created");
  if (!created) throw new Error("Relay task event log is missing task.created.");
  const task: RelayTask = {
    id: created.taskId,
    title: created.title,
    description: created.description,
    priority: created.priority,
    ...(created.ownerEmployeeId ? { ownerEmployeeId: created.ownerEmployeeId } : {}),
    ...(created.projectId ? { projectId: created.projectId } : {}),
    ...(created.assigneeEmployeeId ? { assigneeEmployeeId: created.assigneeEmployeeId } : {}),
    ...(created.dueDate ? { dueDate: created.dueDate } : {}),
    status: "backlog",
    isRoutine: Boolean(created.isRoutine),
    routineEnabled: Boolean(created.routineEnabled),
    ...(created.sourceRoutineId ? { sourceRoutineId: created.sourceRoutineId } : {}),
    ...(created.scheduledFor ? { scheduledFor: created.scheduledFor } : {}),
    occurrenceIds: [],
    linkedSessionIds: [],
    activity: [],
    createdAt: created.timestamp,
    updatedAt: created.timestamp,
    events: [],
  };
  applyRoutineFields(task, created);

  for (const event of events) {
    task.events.push(event);
    task.updatedAt = event.timestamp;
    if (event.type === "task.updated") {
      if (event.title !== undefined) task.title = event.title;
      if (event.description !== undefined) task.description = event.description;
      if (event.priority !== undefined) task.priority = event.priority;
      if (event.assigneeEmployeeId !== undefined) {
        if (event.assigneeEmployeeId) task.assigneeEmployeeId = event.assigneeEmployeeId;
        else delete task.assigneeEmployeeId;
      }
      if (event.dueDate !== undefined) {
        if (event.dueDate) task.dueDate = event.dueDate;
        else delete task.dueDate;
      }
      applyRoutineFields(task, event);
    } else if (event.type === "task.assigned") {
      if ("teamId" in event) {
        task.assignedTeamId = event.teamId;
        delete task.assignedAgent;
        delete task.assignedAgentId;
      } else {
        task.assignedAgent = event.agent;
        if (event.agentId) task.assignedAgentId = event.agentId;
        else delete task.assignedAgentId;
        delete task.assignedTeamId;
      }
    } else if (event.type === "task.unassigned") {
      delete task.assignedAgent;
      delete task.assignedAgentId;
      delete task.assignedTeamId;
    } else if (event.type === "task.dispatch_claimed") {
      task.dispatchClaim = event.claim;
    } else if (event.type === "task.dispatch_released") {
      if (task.dispatchClaim?.id === event.claimId) delete task.dispatchClaim;
    } else if (event.type === "task.workspace_wait") {
      if (event.waiting) task.workspaceWaiting = { ...event.waiting };
      else if (task.workspaceWaiting?.runId === event.runId) delete task.workspaceWaiting;
    } else if (event.type === "task.workspace_bound") {
      task.workspaceBinding = { ...event.binding };
    } else if (event.type === "task.dispatch_outcome") {
      task.dispatchOutcome = event.outcome;
    } else if (event.type === "task.occurrence_created") {
      if (!task.occurrenceIds?.includes(event.occurrenceId)) task.occurrenceIds?.push(event.occurrenceId);
    } else if (event.type === "task.status") {
      task.status = event.status;
      if (event.status !== "running") delete task.workspaceWaiting;
    } else if (event.type === "task.deleted") {
      task.deletedAt = event.timestamp;
    } else if (event.type === "task.session_linked") {
      if (!task.linkedSessionIds.includes(event.sessionId)) task.linkedSessionIds.push(event.sessionId);
    } else if (event.type === "task.session_unlinked") {
      task.linkedSessionIds = task.linkedSessionIds.filter((sessionId) => sessionId !== event.sessionId);
    } else if (event.type === "task.activity") {
      task.activity.push(event.activity);
    }
  }
  return task;
}

function applyRoutineFields(task: RelayTask, event: Partial<Extract<RelayTaskEvent, { type: "task.created" | "task.updated" }>>): void {
  if (event.isRoutine !== undefined) {
    task.isRoutine = event.isRoutine;
    if (!event.isRoutine) {
      task.routineEnabled = false;
      delete task.routineType;
      delete task.routineCadence;
      delete task.routineNextRunDate;
      return;
    }
  }
  if (!task.isRoutine) return;
  if (event.routineEnabled !== undefined) task.routineEnabled = event.routineEnabled;
  if (event.routineType !== undefined) task.routineType = event.routineType;
  if (event.routineCadence !== undefined) task.routineCadence = event.routineCadence;
  if (event.routineNextRunDate !== undefined) {
    if (event.routineNextRunDate) task.routineNextRunDate = event.routineNextRunDate;
    else delete task.routineNextRunDate;
  }
}

export function taskPriority(value: unknown): TaskPriority | undefined {
  return value === "low" || value === "normal" || value === "high" ? value : undefined;
}

export function taskStatus(value: unknown): TaskStatus | undefined {
  return value === "backlog" || value === "assigned" || value === "running" || value === "waiting_for_human" || value === "review" || value === "done" || value === "blocked"
    ? value
    : undefined;
}

export function taskRoutineType(value: unknown): TaskRoutineType | undefined {
  return value === "task" || value === "job" ? value : undefined;
}

export function taskRoutineCadence(value: unknown): TaskRoutineCadence | undefined {
  return value === "daily" || value === "weekly" || value === "monthly" || value === "custom" ? value : undefined;
}
