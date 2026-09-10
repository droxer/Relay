import type {
  AgentName,
  AgentRole,
  ControlPanelDaemonNodeRecord,
  DaemonAgentInventory,
  DaemonAgentMcpServer,
  DaemonAgentSkill,
  DaemonMcpTransport,
  DaemonNodeMonitorRecord,
  RelayArtifact,
  RelayTask,
  RelayTaskEvent,
  RelayTaskListItem,
  RelayTaskSummary,
  RelaySession,
  SandboxRecord,
  SessionStatus,
  TaskPriority,
  TaskRoutineCadence,
  TaskRoutineType,
  TaskStatus,
  TokenUsage,
} from "relay-core";
import type { Language, Theme } from "./lib/appStorage.js";

export type {
  AgentName,
  AgentRole,
  ControlPanelDaemonNodeRecord,
  DaemonAgentInventory,
  DaemonAgentMcpServer,
  DaemonAgentSkill,
  DaemonMcpTransport,
  DaemonNodeMonitorRecord,
  RelayArtifact,
  RelayTask,
  RelayTaskEvent,
  RelayTaskListItem,
  RelayTaskSummary,
  RelaySession,
  SandboxRecord,
  SessionStatus,
  TaskPriority,
  TaskRoutineCadence,
  TaskRoutineType,
  TaskStatus,
  TokenUsage,
};

/**
 * Canonical agent ordering for web surfaces. Mirrors AGENT_REGISTRY in
 * relay-core/src/agents.ts (which isn't importable here because web bundles
 * can't pull node-only modules — see CLAUDE.md). Update both when adding an
 * agent.
 */
export const AGENT_NAMES: AgentName[] = ["claude", "pi", "codex", "kimi"];

/** Single tone vocabulary for every status surface (toasts, pills, dots, stream status, system rows). */
export type Tone = "good" | "bad" | "warn" | "info" | "neutral";

export interface SessionsResponse {
  sessions: RelaySession[];
}

export interface SessionSummary {
  id: string;
  title?: string;
  taskGoal: string;
  status: RelaySession["status"];
  phase: string;
  daemonNodeId?: string;
  managedNodeId?: string;
  workspacePath: string;
  ownerEmployeeId?: string;
  ownerAgentId?: string;
  teamId?: string;
  projectId?: string;
  workspaceLayout?: "node-root" | "thread" | "project" | "task";
  workspaceSubpath?: string;
  computerId?: string;
  currentAgent?: AgentName;
  pendingDecision?: RelaySession["pendingDecision"];
  archived?: boolean;
  artifactCount: number;
  runCount: number;
  eventCount: number;
  updatedAt: string;
  createdAt: string;
}

export interface SessionSummariesResponse {
  sessions: SessionSummary[];
}

export interface ArtifactIndexItem extends RelayArtifact {
  sessionId: string;
  sessionTitle?: string;
  taskGoal?: string;
  ownerEmployeeId?: string;
  workspacePath?: string;
  sessionUpdatedAt?: string;
  taskId?: string;
}

export interface ArtifactsResponse {
  artifacts: ArtifactIndexItem[];
}

export interface TaskArtifactsResponse {
  taskId: string;
  artifacts: ArtifactIndexItem[];
}

export type ProducedFileCurrency = "current" | "changed-since" | "deleted" | "unknown";

export type SnapshotSkippedReason =
  | "too-large"
  | "not-snapshotable-type"
  | "sensitive"
  | "unreadable";

/** One file a run of this task created or modified. */
export interface ProducedFile extends ArtifactIndexItem {
  currency: ProducedFileCurrency;
  snapshotSkipped?: SnapshotSkippedReason;
}

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
}

export interface TaskRunsResponse {
  taskId: string;
  runs: TaskRun[];
}

export interface TaskDeletionResponse {
  task: RelayTask;
  outcome: "deleted" | "already_deleted";
}

export interface WorkspaceBriefSession {
  id: string;
  projectId?: string;
  title?: string;
  taskGoal?: string;
  status?: RelaySession["status"];
  phase?: string;
  daemonNodeId?: string;
  managedNodeId?: string;
  workspacePath?: string;
  ownerEmployeeId?: string;
  ownerAgentId?: string;
  teamId?: string;
  currentAgent?: AgentName;
  pendingDecision?: RelaySession["pendingDecision"];
  artifactCount: number;
  runCount: number;
  updatedAt?: string;
  createdAt?: string;
}

export interface WorkspaceBriefTask {
  id: string;
  projectId?: string;
  title?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  ownerEmployeeId?: string;
  assigneeEmployeeId?: string;
  assignedAgent?: AgentName;
  assignedAgentId?: string;
  assignedTeamId?: string;
  dueDate?: string;
  isRoutine: boolean;
  routineType?: TaskRoutineType;
  routineCadence?: TaskRoutineCadence;
  routineNextRunDate?: string;
  routineEnabled: boolean;
  linkedSessionIds: string[];
  updatedAt?: string;
  createdAt?: string;
}

export interface WorkspaceBriefResponse {
  employeeId: string;
  teamId?: string;
  projectId?: string;
  workspacePath?: string;
  nodes: DaemonNodeMonitorRecord[];
  activeRuns: DaemonNodeMonitorRecord["activeRuns"];
  sessions: WorkspaceBriefSession[];
  tasks: WorkspaceBriefTask[];
  artifacts: ArtifactIndexItem[];
  metrics: {
    nodeCount: number;
    activeRunCount: number;
    sessionCount: number;
    activeSessionCount: number;
    taskCount: number;
    activeTaskCount: number;
    artifactCount: number;
  };
  generatedAt: string;
}

export type WorkspaceFileKind = "directory" | "file";

export interface WorkspaceFileEntry {
  name: string;
  path: string;
  kind: WorkspaceFileKind;
  bytes?: number | null;
  updatedAt: string;
}


export interface ProjectWorkspaceFilesResponse {
  projectId: string;
  scope: "shared";
  source: "live";
  nodeId: string;
  path: string;
  exists: boolean;
  entries: WorkspaceFileEntry[];
  generatedAt: string;
}

export interface ProjectWorkspaceFileResponse {
  projectId: string;
  scope: "shared";
  source: "live";
  nodeId: string;
  path: string;
  exists: boolean;
  isBinary: boolean;
  bytes: number;
  content: string | null;
  contentBase64?: string | null;
  truncated: boolean;
  limitBytes: number;
  generatedAt: string;
}

export interface TaskWorkspaceFilesResponse {
  workspaceLayout?: "thread" | "task" | "project" | "node-root";
  sharedWithProject?: boolean;
  taskId: string;
  scope: "shared";
  source: "live";
  nodeId: string;
  path: string;
  exists: boolean;
  entries: WorkspaceFileEntry[];
  generatedAt: string;
}

export interface TaskWorkspaceFileResponse {
  taskId: string;
  scope: "shared";
  source: "live";
  nodeId: string;
  path: string;
  exists: boolean;
  isBinary: boolean;
  bytes: number;
  content: string | null;
  contentBase64?: string | null;
  truncated: boolean;
  limitBytes: number;
  generatedAt: string;
}

export interface NodeWorkspaceFilesResponse {
  nodeId: string;
  scope: "shared";
  source: "live";
  path: string;
  exists: boolean;
  entries: WorkspaceFileEntry[];
  generatedAt: string;
}

export interface NodeWorkspaceFileResponse {
  nodeId: string;
  scope: "shared";
  source: "live";
  path: string;
  exists: boolean;
  isBinary: boolean;
  bytes: number;
  content: string | null;
  /** Raw bytes (base64, capped at limitBytes) for binary previews — images, PDFs. */
  contentBase64?: string | null;
  truncated: boolean;
  limitBytes: number;
  generatedAt: string;
}

export interface TasksResponse {
  tasks: RelayTaskSummary[];
}

export interface ProjectMember {
  agentId: string;
  role: AgentRole;
  functionTitle: string;
  responsibilities: string;
  instructions?: string;
  enabled: boolean;
}

export interface ProjectRecord {
  id: string;
  ownerEmployeeId: string;
  name: string;
  computerId: string;
  workspaceLayout: "project";
  workspaceSubpath: string;
  leadAgentId: string | null;
  members: ProjectMember[];
  enabled: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
}

export interface ProjectsResponse {
  projects: ProjectRecord[];
}

export interface CreateProjectInput {
  name: string;
  daemonNodeId: string;
  leadAgentId?: string | null;
  members: Array<{
    agentId: string;
    role: AgentRole;
    functionTitle: string;
    responsibilities: string;
    instructions?: string;
    enabled?: boolean;
  }>;
}

export interface UpdateProjectInput {
  expectedVersion: number;
  name?: string;
  leadAgentId?: string | null;
  members?: CreateProjectInput["members"];
  enabled?: boolean;
}

export interface SandboxesResponse {
  sandboxes: SandboxRecord[];
}

export interface DaemonNodesResponse {
  nodes: DaemonNodeMonitorRecord[];
}

export interface ControlPanelDaemonNodesResponse {
  nodes: ControlPanelDaemonNodeRecord[];
}

export interface EmployeeRecord {
  id: string;
  /** The @handle. `id` is a UUID under the database auth store, so this — not
      the id — is what the admin surfaces render. Optional only for records
      from a backend that predates the column. */
  handle?: string;
  displayName: string;
  email?: string;
  departmentId?: string;
  departmentName?: string;
  /** Pinned personal-computer limit; null/undefined means it follows the org default. */
  maxLocalComputers?: number | null;
  /** The override when there is one, the org default otherwise. Resolved server-side. */
  effectiveMaxLocalComputers?: number;
  /** Live personal computers the employee currently owns. */
  localComputerCount?: number;
  createdAt?: string;
  updatedAt?: string;
}

export interface OrgSettings {
  maxLocalComputersPerEmployee: number;
  /** How many extra rounds a task may run when it reports itself unfinished. */
  maxTaskRounds: number;
  updatedAt?: string | null;
}

export interface OrgSettingsResponse {
  settings: OrgSettings;
  capabilities?: {
    /** False when the auth store cannot hold employee edits (name, email, limit). */
    employeeEdits?: boolean;
  };
  /** Admin bearer token for bootstrap/supervisor use. */
  adminToken?: string | null;
}

export interface UpdateControlPanelEmployeeInput {
  employeeId: string;
  displayName?: string;
  email?: string;
  /** `null` clears the override so the employee follows the org default again. */
  maxLocalComputers?: number | null;
}

export interface ControlPanelEmployeesResponse {
  employees: EmployeeRecord[];
}

export interface CreateControlPanelEmployeeInput {
  employeeId: string;
  username: string;
  password: string;
  nodeId?: string;
  email?: string;
  displayName?: string;
  maxLocalComputers?: number | null;
}

export interface CreateControlPanelEmployeeResponse {
  employee: EmployeeRecord;
  user: CurrentUser;
  node?: ControlPanelDaemonNodeRecord;
  /** Set when the employee was created but the requested computer could not be
      attached (someone else claimed it first). The employee is still real — the
      admin resolves the computer from the assign flow. */
  assignmentError?: string;
}

export interface AssignControlPanelDaemonNodeResponse {
  employee: EmployeeRecord;
  node: ControlPanelDaemonNodeRecord;
}

export interface UnassignControlPanelDaemonNodeResponse {
  node: ControlPanelDaemonNodeRecord;
}

interface CreateControlPanelDaemonNodeCommon {
  employeeId?: string;
  displayName?: string;
}

/** `nodeLocation` and `sandboxMode` are not independent, so they are paired in
    the type rather than left to each call site: an employee device runs agents
    as host processes against the installs already on it, and BoxLite isolation
    belongs to hardware an admin provisions. Both admin drawers had drifted to
    sending the isolated runtime for a local computer, which the backend now
    also refuses — this makes it a compile error instead of a start command the
    employee's laptop cannot execute. */
export type CreateControlPanelDaemonNodeInput =
  | (CreateControlPanelDaemonNodeCommon & {
      nodeLocation: "employee-device";
      /** Where the agents' work lands on that device; required, and absolute. */
      workspacePath: string;
      sandboxMode: "none";
    })
  | (CreateControlPanelDaemonNodeCommon & {
      nodeLocation?: never;
      workspacePath?: string;
      /** Runtime isolation only; management ownership is represented by managedNodeId. */
      sandboxMode?: "boxlite";
    });

export interface CreateControlPanelDaemonNodeResponse {
  node: ControlPanelDaemonNodeRecord;
  sandboxToken?: string;
  nodeToken?: string;
  daemonCommand?: string;
  daemonEnv: Record<string, string>;
}

/** Self-service registration of the caller's own device — no employeeId, the backend
    attributes it to the authenticated actor, and no sandboxMode: a personal computer
    runs its agents directly. */
export interface CreateLocalDeviceEnrollmentInput {
  workspacePath: string;
  displayName?: string;
}

export interface CreateLocalDeviceEnrollmentResponse extends CreateControlPanelDaemonNodeResponse {
  /** True when an existing computer was adopted instead of a new one created. */
  reused?: boolean;
}

/** Owner-scoped answer to a reveal or reissue: the plaintext launch token plus
    the env and command that start the daemon with it. */
export interface ComputerTokenResponse {
  nodeToken: string;
  daemonEnv: Record<string, string>;
  daemonCommand?: string;
}

export type ManagedNodePhase =
  | "requested"
  | "allocating"
  | "bootstrapping"
  | "registering"
  | "recovering"
  | "ready"
  | "draining"
  | "stopped"
  | "deleting"
  | "deleted"
  | "failed";

export interface ManagedNodeRecord {
  id: string;
  displayName: string;
  employeeId?: string;
  assignmentMode: "dedicated" | "pooled" | "shared";
  provider: string;
  profile: string;
  sandboxMode: "boxlite";
  workspacePolicy: Record<string, unknown>;
  desiredState: "running" | "stopped" | "deleted";
  generation: number;
  phase: ManagedNodePhase;
  activeAttemptId?: string;
  activeDaemonNodeId?: string;
  conditions: Array<Record<string, unknown>>;
  createdAt: string;
  updatedAt: string;
}

export interface CreateManagedNodeInput {
  employeeId: string;
  displayName?: string;
  sandboxMode: "boxlite";
}

export interface CreateManagedNodeResponse {
  node: ManagedNodeRecord;
}

export interface ManagedNodesResponse {
  nodes: ManagedNodeRecord[];
}

export type LogicalAgentAvailability = "ready" | "busy" | "pending" | "offline";

export interface AgentPlacement {
  id: string;
  agentId: string;
  employeeId: string;
  /** Runtime node observed when the placement was created (audit only). */
  daemonNodeId: string;
  /** Current runtime node resolved through the placement's stable Computer. */
  runtimeNodeId?: string;
  /** Stable Computer identity; runtime node IDs may be replaced. */
  computerId?: string;
  managedNodeId?: string;
  nodeDisplayName?: string;
  nodeOwnership?: "managed" | "employee-device" | "unknown";
  nodeSandboxMode?: "boxlite" | "none";
  executorKind: AgentName;
  desiredState: "active" | "draining" | "removed";
  status: "pending" | "ready" | "busy" | "offline" | "incompatible" | "failed";
  priority: number;
  agentVersion: number;
  workspacePolicy: Record<string, unknown>;
  conditions: Array<{ reason: string; message: string }>;
  createdAt: string;
  updatedAt: string;
}

/** The roles an agent may hold on a team, in the order they are offered.
    Mirrors AGENT_ROLES in relay/core/models.py; the AgentRole type that
    relay-core already owns keeps this list honest. */
export const AGENT_ROLE_OPTIONS: readonly AgentRole[] = [
  "implementer",
  "reviewer",
  "planner",
  "tester",
  "fixer",
];

/** Why an agent cannot currently run, derived live on every read — never
    persisted. "available" means the agent's computer and runtime are both
    present and reachable. */
export type AgentBindingStatus =
  | "available"
  | "computer_gone"
  | "computer_offline"
  | "runtime_missing";

export interface EmployeeAgent {
  id: string;
  employeeId: string;
  displayName: string;
  profileImageUrl?: string | null;
  executorKind: AgentName;
  instructions?: string;
  /** The job this agent does on a team, e.g. "reviewer". Shapes its prompt and,
      for a reviewer, makes it review a round instead of redoing the work. */
  defaultRole?: AgentRole;
  skillPolicy: Record<string, unknown>;
  toolPolicy: Record<string, unknown>;
  modelPolicy: Record<string, unknown>;
  /** Skills installed for this agent's runtime on the computers it runs on.
      Node-reported inventory resolved on read, never a stored agent field. */
  skills?: DaemonAgentSkill[];
  enabled: boolean;
  version: number;
  availability: LogicalAgentAvailability;
  placements: AgentPlacement[];
  /** The computer this agent was explicitly created on. */
  computerId?: string;
  bindingStatus?: AgentBindingStatus;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
}

/** Body for POST /agents — explicit agent creation (computer -> runtime -> role). */
export interface CreateAgentInput {
  computerId: string;
  executorKind: AgentName;
  defaultRole: AgentRole;
  displayName?: string;
  instructions?: string;
}

export interface CreateAgentResponse {
  agent: EmployeeAgent;
}

export interface EmployeeAgentsResponse {
  agents: EmployeeAgent[];
}

export interface TeamMemberSummary {
  id: string;
  displayName: string;
  profileImageUrl?: string | null;
  executorKind: AgentName;
  enabled: boolean;
  availability: LogicalAgentAvailability;
}

export interface AgentTeam {
  id: string;
  ownerEmployeeId: string;
  name: string;
  profileImageUrl?: string | null;
  leadAgentId?: string | null;
  memberAgentIds: string[];
  enabled: boolean;
  members: TeamMemberSummary[];
  lead?: TeamMemberSummary | null;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
}

export interface AgentTeamsResponse {
  teams: AgentTeam[];
}

export interface TeamMutationInput {
  name: string;
  leadAgentId: string;
  memberAgentIds: string[];
  enabled?: boolean;
}

export interface AgentRunInput {
  taskGoal: string;
  /** Computer selected as the immutable runtime for a new thread. */
  daemonNodeId?: string;
  /** Team a brand-new thread belongs to; the backend expands it to the
   *  roster (lead first) and stamps the session with the team id. */
  teamId?: string;
  /** Project a brand-new thread belongs to; the backend expands its roster. */
  projectId?: string;
  /** Absent means "this thread's participants" — the whole team for a team thread. */
  assignments?: Array<{
    agentId: string;
    role?: AgentRole;
    brief?: string;
  }>;
  sessionId?: string;
  userMessageId?: string;
  decision?: {
    kind: "rerun" | "handoff";
    targetAgent: AgentName;
    targetAgentId?: string;
    note?: string;
  };
}

export interface ThreadMessageInput {
  text: string;
  intent: "accomplish" | "discuss" | "review";
  /** Agents this message addresses. Empty or absent means the whole room. */
  addressAgentIds?: string[];
  userMessageId?: string;
  idempotencyKey?: string;
}

export interface ThreadRecoveryInput {
  kind: "rerun" | "handoff";
  targetAgentId: string;
  note?: string;
  idempotencyKey?: string;
}

export interface RunInput {
  sandboxId: string;
  taskGoal: string;
  assignments: Array<{
    agentId?: string;
    agent: AgentName;
    role?: AgentRole;
    brief?: string;
  }>;
  sessionId?: string;
  /** Client-generated id for the follow-up user message, so the optimistic echo
   * reconciles with the persisted event by id. Ignored for new sessions. */
  userMessageId?: string;
  decision?: {
    kind: "rerun" | "handoff";
    note?: string;
    targetAgent?: AgentName;
    targetAgentId?: string;
  };
}

/** Task starts may pin a logical agent by id and let the server resolve its executor. */
export type TaskRunAssignment = Omit<RunInput["assignments"][number], "agent"> & {
  agent?: AgentName;
};

export interface CreateSessionInput {
  taskGoal: string;
  /** Computer selected as the immutable runtime for the thread. */
  daemonNodeId?: string;
  assignments: RunInput["assignments"];
  workspacePath?: string;
  ownerEmployeeId?: string;
}

export interface TaskMutationInput {
  title?: string;
  description?: string;
  priority?: TaskPriority;
  status?: TaskStatus;
  dueDate?: string;
  isRoutine?: boolean;
  routineType?: TaskRoutineType;
  routineCadence?: TaskRoutineCadence;
  routineNextRunDate?: string;
  routineEnabled?: boolean;
  assignedAgentId?: string | null;
  assignedTeamId?: string | null;
}

export interface CreateTaskInput extends TaskMutationInput {
  title: string;
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

export interface ApiErrorBody {
  error?: string;
}

export type UserRole = "admin" | "user";

export interface CurrentUser {
  id: string;
  username: string;
  email?: string;
  role: UserRole;
  employeeId?: string;
  displayName?: string;
  theme?: Theme;
  language?: Language;
  /** Pinned local-computer limit; null/undefined means it follows the org default. */
  maxLocalComputers?: number | null;
  /** Resolved local-computer limit for this user, decorated by /auth/me. */
  effectiveMaxLocalComputers?: number;
  /** Live local computers this user owns, decorated by /auth/me. */
  localComputerCount?: number;
}

export type ChatProvider = "discord" | "telegram" | "lark";
export type ChatIntegrationStatus = "draft" | "active" | "degraded" | "disabled";

export interface ChatIdentityLink {
  id: string;
  externalUserId: string;
  employeeId: string;
  displayName?: string | null;
  defaultAgentId?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ChatAllowedConversation {
  id: string;
  conversationId: string;
  threadId?: string | null;
  label: string;
  createdAt: string;
  updatedAt: string;
}

export interface ChatIntegration {
  id: string;
  provider: ChatProvider;
  displayName: string;
  tenantId?: string | null;
  status: ChatIntegrationStatus;
  config: Record<string, string | number | boolean>;
  health: {
    ok: boolean;
    message: string;
    lastCheckedAt?: string | null;
  };
  secretConfigured: boolean;
  secretKeys: string[];
  identityLinkCount: number;
  allowedConversationCount: number;
  identityLinks: ChatIdentityLink[];
  allowedConversations: ChatAllowedConversation[];
  createdAt: string;
  updatedAt: string;
}

export interface ChatIntegrationsResponse {
  integrations: ChatIntegration[];
}
