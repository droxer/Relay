import type {
  AgentName,
  CollaborationStyle,
  RelaySession,
  RelayTask,
  RelayTaskEvent,
  RelayTaskSummary,
  RoutineOccurrenceTriggerKind,
  RoutineState,
  RoutineTrigger,
  TaskPriority,
  TaskStatus,
} from "relay-core";
import type { ProducedFile } from "./artifacts.ts";
import type { RunInput } from "./sessions.ts";
import type { WorkspaceFileEntry } from "./workspace.ts";

export type TaskLiveStatus =
  | "ok"
  | "offline"
  | "not-created"
  | "unsupported"
  | "denied"
  | "unavailable";

export interface TaskFilesResponse {
  taskId: string;
  produced: ProducedFile[];
  live: {
    status: TaskLiveStatus;
    path: string;
    entries: WorkspaceFileEntry[];
  };
}

export interface TaskEventsResponse {
  events: RelayTaskEvent[];
}

/**
 * One run of a task, as the run ledger reads it.
 *
 * For a routine this is one promoted occurrence — a routine never runs itself.
 * For a plain task there is exactly one row, the task's own run.
 */
export interface TaskRun {
  triggerKind?: RoutineOccurrenceTriggerKind | null;
  triggerSummary?: { eventType: string; toStatus?: TaskStatus; eventCount: number } | null;
  /** The task that carried the run: an occurrence, or the task itself. */
  taskId: string;
  /** The day the run was scheduled for; the ledger's date column. */
  scheduledFor?: string | null;
  status: TaskStatus;
  createdAt: string;
  /** When the run went `running`; null while it is still only assigned. */
  startedAt: string | null;
  /** When the run reached a terminal status; null while it is still going. */
  endedAt: string | null;
  /** Why the run ended blocked, when it did. */
  failureMessage: string | null;
  sessionIds: string[];
  latestSessionId: string | null;
  artifactCount: number;
  /** The folder this run's deliverables live in, relative to the workspace
   *  the Runs tab browses; null when the workspace is that folder. */
  artifactsDir?: string | null;
}

export interface TaskRunsResponse {
  taskId: string;
  runs: TaskRun[];
}

export interface TaskDeletionResponse {
  task: RelayTask;
  outcome: "deleted" | "already_deleted";
}

export interface TasksResponse {
  flowPolicy?: { wipLimit: number; scope: "user" };
  tasks: RelayTaskSummary[];
}

/** Task starts may pin a logical agent by id and let the server resolve its executor. */
export type TaskRunAssignment = Omit<RunInput["assignments"][number], "agent"> & {
  agent?: AgentName;
};

export interface TaskMutationInput {
  collaborationStyle?: CollaborationStyle | "" | null;
  acceptancePolicy?: "human" | "automatic";
  blockerReason?: string;
  action?: "unblock";
  title?: string;
  description?: string;
  priority?: TaskPriority;
  status?: TaskStatus;
  dueDate?: string;
  isRoutine?: boolean;
  routineTriggers?: RoutineTrigger[];
  /** Owners set active or paused; only Relay sets paused_by_relay. */
  routineState?: Exclude<RoutineState, "paused_by_relay">;
  assignedAgentId?: string | null;
  assignedTeamId?: string | null;
  /** Triage: moves an intake issue (one with no project) into a project.
      One way only — the server refuses it for a task that already has one. */
  projectId?: string;
}

export interface CreateTaskInput extends TaskMutationInput {
  title: string;
  /** Omitted for an intake issue, which cannot take an agent or run. */
  projectId?: string;
}

export interface StartTaskResponse {
  task: RelayTask;
  session: RelaySession | null;
  dispatch: {
    state: "started" | "queued" | "rejected";
    code?: string;
    message?: string;
  };
}
