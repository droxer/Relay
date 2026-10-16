import { newRelayId, nowIso } from "./session-store.js";
import type { CollaborationStyle } from "./session-store.js";
import type { AgentName } from "./state.js";

export type TaskPriority = "low" | "normal" | "high";
export type TaskStatus = "backlog" | "assigned" | "running" | "waiting_for_human" | "review" | "done" | "blocked";
/** What fired an occurrence: a trigger kind, or "manual" for Run now. */
export type RoutineTriggerKind = RoutineTrigger["kind"];
export type RoutineOccurrenceTriggerKind = RoutineTriggerKind | "manual";
export type RoutineTriggerOn = "created" | "status_changed" | "completed" | "failed";
export interface RoutineTriggerFilters {
  projectId?: string;
  assignedAgentId?: string;
  assignedTeamId?: string;
  fromStatus?: TaskStatus;
  toStatus?: TaskStatus;
  priority?: TaskPriority;
  titleContains?: string;
}
/** When a schedule trigger fires. Mirrors backend/relay/automations/schedule.py. */
export type ScheduleRepeat =
  | { every: "hour"; minute: number }
  | { every: "day" | "weekday"; at: string }
  | { every: "week"; at: string; days: number[] }
  | { every: "month"; at: string; day: number }
  | { once: string }
  | { cron: string };
/** A schedule; a null timezone means the server's own zone. */
export interface RoutineSchedule {
  timezone: string | null;
  repeat: ScheduleRepeat;
}
export type RoutineTrigger =
  | { kind: "schedule"; schedule: RoutineSchedule }
  | { kind: "task_event" | "run_event"; on: RoutineTriggerOn; filters?: RoutineTriggerFilters }
  | { kind: "webhook" };
export type RoutineState = "active" | "paused" | "paused_by_relay";
export type RoutinePauseReason = "rate_limited" | "failing" | "no_target" | "invalid_schedule";

export interface TaskExecutionAttention {
  schemaVersion: 1;
  code: string;
  source: "dispatch" | "execution" | "operator" | "legacy";
  summary: string;
  evidence: "recorded" | "unknown";
  observedAt: string;
  sessionId?: string;
  runRequestId?: string;
  runId?: string;
}

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

/** What a task waiting on its human waits on (`core/human_waits.py`). */
export type TaskWaitKind = "question" | "check" | "budget";

/** A wait as recorded on its task. Every park since waits carried ids has one;
 *  older waits may hold only the question's words. */
export interface TaskWaitingRequest {
  /** The id an answer names, so a stale reply cannot answer a newer question. */
  questionId?: string;
  kind?: TaskWaitKind;
  inputQuestion?: string;
  /** Answers the agent offered, each sendable as is. */
  inputOptions?: string[];
  /** Acceptance-gate reasons the question stood in front of. */
  inputNotes?: string[];
}

/** What a waiting task asks, as every surface renders it. */
export interface TaskAwaiting {
  /** Null for a wait recorded before waits carried ids. */
  questionId: string | null;
  kind: TaskWaitKind;
  /** The agent's question, or the recorded reason in plain words. */
  text: string | null;
  /** Answers the agent offered, each sendable as is (2–6, or none). */
  options: string[];
  /** Acceptance-gate reasons the question stood in front of. */
  notes: string[];
  /** The thread a reply resumes the task from. */
  sessionId: string | null;
  /** False for a routine template: shown, never resumed by a reply. */
  resumable: boolean;
}

export interface RelayTask {
  collaborationStyle?: CollaborationStyle;
  acceptancePolicy?: "human" | "automatic";
  workflowStage?: "backlog" | "assigned" | "running" | "review" | "done";
  startedAt?: string;
  finishedAt?: string;
  blockedAt?: string;
  blockedFromStatus?: TaskStatus;
  waitingFromStatus?: TaskStatus;
  /** What the agent asked for while the task waits on a human. */
  waitingReason?: string;
  /** The thread the answer belongs in, when the wait came from a round. */
  waitingSessionId?: string;
  /** The wait record: its id, kind, and the agent's question if it asked. */
  waitingRequest?: TaskWaitingRequest;
  /** The wait projected once by the API (`task_awaiting`); null when the
   *  task is not waiting. Absent on records this package reduces itself. */
  awaiting?: TaskAwaiting | null;
  blockerReason?: string;
  attention?: TaskExecutionAttention;
  blockerOwnerUserId?: string;
  executionOwner?: { requestId: string; revision: number };
  id: string;
  /** Human-facing sequence number, counted per scope: a project's issues, an
   * user's other issues, or a user's automations. */
  number?: number;
  /** The counter `number` was drawn from, e.g. `project:<id>`. */
  numberScope?: string;
  title: string;
  description: string;
  priority: TaskPriority;
  status: TaskStatus;
  /** User who owns this task; their agent carries it out on their behalf. */
  ownerUserId?: string;
  /** Project whose conversations and workspace contain this task. */
  projectId?: string;
  /** Human assignee responsible for the backlog item. */
  assigneeUserId?: string;
  /** Date-only due date in YYYY-MM-DD format. */
  dueDate?: string;
  isRoutine: boolean;
  /** What starts the automation; empty means Run now only. */
  routineTriggers?: RoutineTrigger[];
  routineState?: RoutineState;
  /** Why Relay paused it; only with `paused_by_relay`. */
  routinePauseReason?: RoutinePauseReason;
  /** Next scheduled fire, ISO UTC; absent when nothing is scheduled. */
  routineNextRunAt?: string;
  /** On an occurrence: what fired it. */
  routineTriggerKind?: RoutineOccurrenceTriggerKind;
  routineTriggerDepth?: number;
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
      type: "task.execution.claimed";
      taskId: string;
      timestamp: string;
      requestId: string;
      expectedRevision: number;
      revision: number;
      expectedStatus?: TaskStatus;
    }
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
      collaborationStyle?: CollaborationStyle | null;
      taskId: string;
      timestamp: string;
      title: string;
      description: string;
      priority: TaskPriority;
      acceptancePolicy?: "human" | "automatic";
      ownerUserId?: string;
      projectId?: string;
      assigneeUserId?: string;
      dueDate?: string;
      isRoutine?: boolean;
      routineTriggers?: RoutineTrigger[];
      routineState?: RoutineState;
      routinePauseReason?: RoutinePauseReason | null;
      routineNextRunAt?: string | null;
      routineTriggerKind?: RoutineOccurrenceTriggerKind;
      routineTriggerDepth?: number;
      sourceRoutineId?: string;
      scheduledFor?: string;
    }
  | {
      id: string;
      type: "task.updated";
      collaborationStyle?: CollaborationStyle | "" | null;
      taskId: string;
      timestamp: string;
      title?: string;
      description?: string;
      priority?: TaskPriority;
      acceptancePolicy?: "human" | "automatic";
      assigneeUserId?: string;
      dueDate?: string;
      isRoutine?: boolean;
      routineTriggers?: RoutineTrigger[];
      routineState?: RoutineState;
      routinePauseReason?: RoutinePauseReason | null;
      routineNextRunAt?: string | null;
      routineTriggerKind?: RoutineOccurrenceTriggerKind;
      routineTriggerDepth?: number;
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
      /** Triage: an intake issue joined a project. */
      type: "task.project_set";
      taskId: string;
      timestamp: string;
      projectId: string;
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
      attention?: Partial<TaskExecutionAttention>;
      actorUserId?: string;
      /** For `waiting_for_human`: the thread the answer belongs in. */
      sessionId?: string;
      /** For `waiting_for_human`: the agent's structured question. */
      request?: TaskWaitingRequest;
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
    ...(created.ownerUserId ? { ownerUserId: created.ownerUserId } : {}),
    ...(created.projectId ? { projectId: created.projectId } : {}),
    ...(created.assigneeUserId ? { assigneeUserId: created.assigneeUserId } : {}),
    ...(created.dueDate ? { dueDate: created.dueDate } : {}),
    status: "backlog",
    workflowStage: "backlog",
    acceptancePolicy: created.acceptancePolicy ?? "automatic",
    ...(created.collaborationStyle ? { collaborationStyle: created.collaborationStyle } : {}),
    isRoutine: Boolean(created.isRoutine),
    ...(created.routineTriggerKind ? { routineTriggerKind: created.routineTriggerKind } : {}),
    ...(created.routineTriggerDepth !== undefined ? { routineTriggerDepth: created.routineTriggerDepth } : {}),
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
      if (event.collaborationStyle != null) {
        if (event.collaborationStyle) task.collaborationStyle = event.collaborationStyle;
        else delete task.collaborationStyle;
      }
      if (event.acceptancePolicy != null) task.acceptancePolicy = event.acceptancePolicy;
      if (event.title !== undefined) task.title = event.title;
      if (event.description !== undefined) task.description = event.description;
      if (event.priority !== undefined) task.priority = event.priority;
      if (event.assigneeUserId !== undefined) {
        if (event.assigneeUserId) task.assigneeUserId = event.assigneeUserId;
        else delete task.assigneeUserId;
      }
      if (event.dueDate !== undefined) {
        if (event.dueDate) task.dueDate = event.dueDate;
        else delete task.dueDate;
      }
      applyRoutineFields(task, event);
    } else if (event.type === "task.project_set") {
      task.projectId = event.projectId;
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
    } else if (event.type === "task.execution.claimed") {
      task.startedAt ??= event.timestamp;
      applyFlowStatus(task, { ...event, type: "task.status", status: "assigned" });
      task.status = "assigned";
      task.executionOwner = { requestId: event.requestId, revision: event.revision };
    } else if (event.type === "task.status") {
      applyFlowStatus(task, event);
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
      delete task.routineTriggers;
      delete task.routineState;
      delete task.routinePauseReason;
      delete task.routineNextRunAt;
      return;
    }
  }
  if (!task.isRoutine) return;
  if (event.routineTriggers !== undefined) task.routineTriggers = structuredClone(event.routineTriggers);
  if (event.routineState !== undefined) {
    task.routineState = event.routineState;
    if (event.routineState !== "paused_by_relay") delete task.routinePauseReason;
  }
  if (event.routinePauseReason !== undefined) {
    if (event.routinePauseReason) task.routinePauseReason = event.routinePauseReason;
    else delete task.routinePauseReason;
  }
  if (event.routineNextRunAt !== undefined) {
    if (event.routineNextRunAt) task.routineNextRunAt = event.routineNextRunAt;
    else delete task.routineNextRunAt;
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

function applyFlowStatus(task: RelayTask, event: Extract<RelayTaskEvent, { type: "task.status" }>): void {
  const status = event.status;
  let stage = task.workflowStage ?? "backlog";
  if (status === "blocked" || status === "waiting_for_human") {
    if (task.status !== status) {
      if (status === "blocked") task.blockedFromStatus = task.status;
      else task.waitingFromStatus = task.status;
    }
    if (status === "blocked") {
      task.blockedAt ??= event.timestamp;
      task.blockerReason = event.reason || "Execution needs attention.";
      const metadata = event.attention ?? {};
      const reason = typeof event.reason === "string" ? event.reason.trim().slice(0, 2000) : "";
      const known = Boolean(reason && reason !== "Execution needs attention.");
      task.attention = {
        schemaVersion: 1,
        code: typeof metadata.code === "string" && metadata.code && metadata.code.length <= 100 ? metadata.code : "unknown",
        source: ["dispatch", "execution", "operator", "legacy"].includes(metadata.source ?? "") ? metadata.source! : "legacy",
        summary: known ? reason : "The blocking event did not record a cause.",
        evidence: known ? "recorded" : "unknown",
        observedAt: event.timestamp,
      };
      for (const key of ["sessionId", "runRequestId", "runId"] as const) {
        const value = metadata[key];
        if (typeof value === "string" && value && value.length <= 200) task.attention[key] = value;
      }
      task.blockerOwnerUserId = event.actorUserId || task.assigneeUserId || task.ownerUserId || "unowned";
    } else {
      task.waitingReason = event.reason || "Execution needs attention.";
      if (event.sessionId) task.waitingSessionId = event.sessionId;
      else delete task.waitingSessionId;
      if (event.request && Object.keys(event.request).length) task.waitingRequest = { ...event.request };
      else delete task.waitingRequest;
    }
    if (stage === "done" || (status === "waiting_for_human" && stage === "backlog")) stage = "running";
  } else {
    // An execution claim reserves WIP before the daemon starts the agent.
    // Keep that admitted work Ready until an actual running event arrives.
    stage = status;
  }
  if (status !== "blocked") {
    delete task.blockedAt;
    delete task.blockedFromStatus;
    delete task.blockerReason;
    delete task.attention;
    delete task.blockerOwnerUserId;
  }
  if (status !== "waiting_for_human") {
    delete task.waitingFromStatus;
    delete task.waitingReason;
    delete task.waitingSessionId;
    delete task.waitingRequest;
  }
  if (["running", "review", "waiting_for_human"].includes(status) && !task.isRoutine) task.startedAt ??= event.timestamp;
  if (status === "done") task.finishedAt ??= event.timestamp;
  else delete task.finishedAt;
  task.workflowStage = stage;
}
