import type {
  AgentName,
  CollaborationStyle,
  RelaySession,
  RelayTask,
  RelayTaskEvent,
  RelayTaskListItem,
  RelayTaskSummary,
  RoutineOccurrenceTriggerKind,
  RoutineState,
  RoutineTrigger,
  TaskPriority,
  TaskPermissionMode,
  TaskStatus,
} from "relay-core";
import type { ArtifactIndexItem, ProducedFile } from "./artifacts.ts";
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
  nextCursor?: string | null;
  nextBefore?: number | null;
  previousStatus?: TaskStatus;
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
  nextCursor?: string | null;
}

export interface TaskDeletionResponse {
  task: RelayTask;
  outcome: "deleted" | "already_deleted";
}

export interface TasksResponse {
  flowPolicy?: { wipLimit: number; scope: "user" };
  flowUsage?: { userId: string; occupied: number };
  tasks: RelayTaskSummary[];
  nextCursor?: string | null;
  homeProjects?: Record<string, HomeProjectTaskSummary>;
  homeUntriaged?: HomeUntriagedSummary | null;
  homeWaitingToStart?: number;
  threadTaskContext?: ThreadTaskContext;
  projectDashboard?: ProjectDashboardSummary;
}

export interface ProjectDashboardSummary {
  metrics: Record<"total" | "active" | "blocked" | "overdue" | "done", number>;
  openTaskCount?: number;
  attentionTotal: number;
  hasQueuedOrRunning: boolean;
  attention: {
    task: Pick<RelayTaskListItem, "id" | "number" | "title" | "dueDate" | "isRoutine">;
    reason: "blocked" | "overdue";
    overdue: boolean;
  }[];
}

export interface ThreadTaskContext {
  threadId: string;
  eventCount: number;
  activeTaskId: string | null;
  permissionMode?: TaskPermissionMode;
  nextSteps: string[];
}

export const TASK_LIST_SCOPES = ["home", "issues", "board", "automations", "project-dashboard"] as const;
export type TaskListScope = (typeof TASK_LIST_SCOPES)[number];

export function isTaskListScope(value: unknown): value is TaskListScope {
  return typeof value === "string" && (TASK_LIST_SCOPES as readonly string[]).includes(value);
}

export interface HomeUntriagedSummary {
  count: number;
  firstCreatedAt: string;
  lastCreatedAt: string;
}

export interface HomeProjectTaskSummary {
  total: number;
  progress: Record<"done" | "review" | "running" | "blocked", number>;
  updatedAt: string;
}

/** Task starts may pin a logical agent by id and let the server resolve its executor. */
export type TaskRunAssignment = Omit<RunInput["assignments"][number], "agent"> & {
  agent?: AgentName;
};

export interface TaskMutationInput {
  /** Associates legacy standalone work once; cannot move an existing workspace. */
  computerId?: string;
  connectionGrants?: import("./connections.ts").ConnectionGrant[];
  /** Accept only the recorded work shown in this review revision. */
  reviewRevision?: string;
  collaborationStyle?: CollaborationStyle | "" | null;
  acceptancePolicy?: "human" | "automatic";
  permissionMode?: TaskPermissionMode;
  blockerReason?: string;
  action?: "unblock";
  title?: string;
  description?: string;
  priority?: TaskPriority;
  /** Replaces the task's tags; an empty list clears them. */
  tags?: string[];
  status?: TaskStatus;
  dueDate?: string;
  isRoutine?: boolean;
  routineTriggers?: RoutineTrigger[];
  /** Owners set active or paused; only Relay sets paused_by_relay. */
  routineState?: Exclude<RoutineState, "paused_by_relay">;
  assignedAgentId?: string | null;
  assignedTeamId?: string | null;
  assignedWorkflowId?: string | null;
  /** Triage: moves an intake issue (one with no project) into a project.
      One way only — the server refuses it for a task that already has one. */
  projectId?: string;
}

export interface TaskReviewReport {
  runId: string;
  agent: AgentName | null;
  agentId: string | null;
  agentName?: string | null;
  role: string | null;
  status: string;
  exitCode: number | null;
  completedAt: string | null;
  workStatus: string | null;
  note: string;
  evidence: string[];
  findings: string[];
  outputTruncated: boolean;
}

export interface TaskReview {
  taskId: string;
  revision: string;
  status: TaskStatus;
  canAccept: boolean;
  goal: string;
  description: string;
  sessionId: string | null;
  roundId: string | null;
  criteria: string[];
  reports: TaskReviewReport[];
  artifacts: (ArtifactIndexItem & { snapshotSkipped?: string | null })[];
  verification: "not_recorded";
  missing: string[];
}

export interface CreateTaskInput extends TaskMutationInput {
  title: string;
  /** Omitted for Computer-scoped work or a legacy unplaced issue. */
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

/** One issue in a GitHub import preview (`POST /tasks/github/issues`). */
export interface GitHubIssuePreview {
  number: number;
  title: string;
  /** Always a `https://github.com/...` link, built server-side. */
  url: string;
  state: "open" | "closed";
  labels: string[];
  author: string | null;
  comments: number;
  createdAt?: string;
  updatedAt?: string;
  /** The task this issue already became in the chosen destination. */
  importedTaskId: string | null;
}

export interface GitHubIssuesResponse {
  repository: { owner: string; name: string; fullName: string };
  page: number;
  hasMore: boolean;
  issues: GitHubIssuePreview[];
}

export type GitHubIssueState = "open" | "closed" | "all";

export interface GitHubIssueQuery {
  repository: string;
  /** An owning User’s GitHub Connection; omitted for anonymous public reads. */
  connectionId?: string;
  /** Omitted for the caller's intake. */
  projectId?: string;
  state?: GitHubIssueState;
  /** Comma-separated label names, as GitHub filters them. */
  labels?: string;
  page?: number;
}

export interface GitHubImportInput {
  repository: string;
  connectionId?: string;
  projectId?: string;
  numbers: number[];
}

/** An issue the import left out, and why (a `github_*` code or a skip reason). */
export interface GitHubImportOutcome {
  number: number;
  reason: string;
  taskId?: string;
}

export interface GitHubImportResponse {
  created: RelayTask[];
  skipped: GitHubImportOutcome[];
  failed: GitHubImportOutcome[];
}
