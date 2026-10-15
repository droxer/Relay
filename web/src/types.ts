import type {
  CollaborationStyle,
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
  RoutineOccurrenceTriggerKind,
  RoutinePauseReason,
  RoutineSchedule,
  RoutineState,
  ScheduleRepeat,
  RoutineTrigger,
  RoutineTriggerKind,
  RoutineTriggerOn,
  RoutineTriggerFilters,
  TaskStatus,
  TokenUsage,
} from "relay-core";
import type { Language, Theme } from "./lib/appStorage.js";

export type {
  CollaborationStyle,
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
  RoutineOccurrenceTriggerKind,
  RoutinePauseReason,
  RoutineSchedule,
  RoutineState,
  ScheduleRepeat,
  RoutineTrigger,
  RoutineTriggerKind,
  RoutineTriggerOn,
  RoutineTriggerFilters,
  TaskStatus,
  TokenUsage,
};

/**
 * Canonical agent ordering for web surfaces. Mirrors AGENT_REGISTRY in
 * relay-core/src/agents.ts (which isn't importable here because web bundles
 * can't pull node-only modules — see AGENTS.md). Update both when adding an
 * agent.
 */
export const AGENT_NAMES: AgentName[] = ["claude", "pi", "codex", "kimi"];

/** Single tone vocabulary for every status surface (toasts, pills, dots, stream status, system rows). */
export type Tone = "good" | "bad" | "warn" | "info" | "neutral";

export interface SessionSummary {
  workOutcome?: RelaySession["workOutcome"] | null;
  execution?: RelaySession["execution"];
  deletionRequestedAt?: string;
  id: string;
  title?: string;
  taskGoal: string;
  status: RelaySession["status"];
  phase: string;
  daemonNodeId?: string;
  managedNodeId?: string;
  workspacePath: string;
  ownerUserId?: string;
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
  ownerUserId?: string;
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
  ownerUserId?: string;
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
  ownerUserId?: string;
  assigneeUserId?: string;
  assignedAgent?: AgentName;
  assignedAgentId?: string;
  assignedTeamId?: string;
  dueDate?: string;
  isRoutine: boolean;
  routineTriggers?: RoutineTrigger[];
  routineState?: RoutineState;
  routinePauseReason?: RoutinePauseReason;
  routineNextRunAt?: string;
  linkedSessionIds: string[];
  updatedAt?: string;
  createdAt?: string;
}

export interface WorkspaceBriefResponse {
  userId: string;
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

export interface TasksResponse {
  flowPolicy?: { wipLimit: number; scope: "user" };
  tasks: RelayTaskSummary[];
}

export interface ProjectMember {
  agentId: string;
  role: AgentRole;
  responsibilities: string;
  instructions?: string;
  enabled: boolean;
}

export type ProjectSetupState = "drafting" | "proposed" | "failed" | "applied" | "dismissed";

/** Why a proposed member cannot be applied as is (services/project_setup.py). */
export type ProjectSetupMemberIssue = "agent_not_found" | "agent_wrong_owner" | "agent_disabled" | "agent_off_computer";

export interface ProjectSetupProposal {
  name?: string;
  goal?: string;
  description?: string;
  context?: string;
  rationale?: string;
  leadAgentId?: string;
  members?: Array<{
    agentId: string;
    role: AgentRole;
    responsibilities: string;
    instructions?: string;
    issue?: ProjectSetupMemberIssue;
  }>;
  tasks?: Array<{ title: string; description?: string; assignedAgentId?: string }>;
}

/** An agent-drafted setup: an agent proposes, the owner applies. */
export interface ProjectSetup {
  state: ProjectSetupState;
  intent: string;
  agentId: string;
  threadId: string | null;
  startedAt: string;
  finishedAt?: string;
  resolvedAt?: string;
  error?: string;
  proposal?: ProjectSetupProposal;
}

export interface ProjectSetupCandidate {
  agentId: string;
  name: string;
  executorKind?: string;
  defaultRole?: AgentRole;
}

export interface ProjectSetupResponse {
  setup: ProjectSetup | null;
  candidates: ProjectSetupCandidate[];
}

export interface StartProjectSetupInput {
  intent: string;
  agentId?: string;
  /** Draft again in the same thread from the last proposal. */
  revise?: boolean;
}

export interface ProjectContextSuggestion {
  id: string;
  text: string;
  evidence?: string;
  threadId: string;
  runId: string;
  agentId?: string;
  createdAt: string;
}

export interface ProjectRecord {
  id: string;
  ownerUserId: string;
  name: string;
  /** What the project is for. Absent on projects created before it existed. */
  description?: string;
  /** The one-line outcome every run in the project is told. */
  goal?: string;
  /** Standing conventions and constraints every run in the project reads. */
  context?: string;
  /** Bumped whenever `context` changes; runs pin the revision they read. */
  contextRevision?: number;
  /** The latest agent-drafted setup, absent when none was ever asked for. */
  setup?: ProjectSetup;
  /** Context lines project runs proposed, waiting for the owner to adopt or dismiss. */
  contextSuggestions?: ProjectContextSuggestion[];
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
  description?: string;
  goal?: string;
  context?: string;
  daemonNodeId: string;
  leadAgentId?: string | null;
  members: Array<{
    agentId: string;
    role: AgentRole;
    responsibilities: string;
    instructions?: string;
    enabled?: boolean;
  }>;
}

export interface UpdateProjectInput {
  expectedVersion: number;
  name?: string;
  description?: string;
  goal?: string;
  context?: string;
  leadAgentId?: string | null;
  members?: CreateProjectInput["members"];
  enabled?: boolean;
  /** Closes the project's drafted setup in the same revision. */
  setupResolution?: "applied" | "dismissed";
  /** Suggestions this save adopted or dismissed; both leave the pending list. */
  resolveContextSuggestions?: string[];
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

export interface UserRecord {
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
  /** Live personal computers the user currently owns. */
  localComputerCount?: number;
  createdAt?: string;
  updatedAt?: string;
}

export interface OrgSettings {
  maxLocalComputersPerUser: number;
  /** How many extra rounds a task may run when it reports itself unfinished. */
  maxTaskRounds: number;
  updatedAt?: string | null;
}

export interface OrgSettingsResponse {
  settings: OrgSettings;
  capabilities?: {
    /** False when the auth store cannot hold user edits (name, email, limit). */
    userEdits?: boolean;
  };
  /** Whether an admin bearer token exists. Only its hash is stored, so the
      value itself comes back once, from the reissue route. */
  adminTokenConfigured?: boolean;
}

export interface UpdateControlPanelUserInput {
  userId: string;
  displayName?: string;
  email?: string;
  /** `null` clears the override so the user follows the org default again. */
  maxLocalComputers?: number | null;
}

export interface ControlPanelUsersResponse {
  users: UserRecord[];
}

export interface CreateControlPanelUserInput {
  userId: string;
  username: string;
  password: string;
  nodeId?: string;
  email?: string;
  displayName?: string;
  maxLocalComputers?: number | null;
}

export interface CreateControlPanelUserResponse {
  user: UserRecord;
  account: CurrentUser;
  node?: ControlPanelDaemonNodeRecord;
  /** Set when the user was created but the requested computer could not be
      attached (someone else claimed it first). The user is still real — the
      admin resolves the computer from the assign flow. */
  assignmentError?: string;
}

export interface AssignControlPanelDaemonNodeResponse {
  user: UserRecord;
  node: ControlPanelDaemonNodeRecord;
}

export interface UnassignControlPanelDaemonNodeResponse {
  node: ControlPanelDaemonNodeRecord;
}

interface CreateControlPanelDaemonNodeCommon {
  userId?: string;
  displayName?: string;
}

/** `nodeLocation` and `sandboxMode` are not independent, so they are paired in
    the type rather than left to each call site: a user device runs agents
    as host processes against the installs already on it, and BoxLite isolation
    belongs to hardware an admin provisions. Both admin drawers had drifted to
    sending the isolated runtime for a local computer, which the backend now
    also refuses — this makes it a compile error instead of a start command the
    user's laptop cannot execute. */
export type CreateControlPanelDaemonNodeInput =
  | (CreateControlPanelDaemonNodeCommon & {
      nodeLocation: "user-device";
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

/** Self-service registration of the caller's own device — no userId, the backend
    attributes it to the authenticated actor, and no sandboxMode: a personal computer
    runs its agents directly. */
export interface CreateLocalDeviceEnrollmentInput {
  workspacePath: string;
  displayName?: string;
}

export interface CreateLocalDeviceEnrollmentResponse extends CreateControlPanelDaemonNodeResponse {
  /** Downloads the client and starts a per-user service; contains no credential. */
  installCommand?: string;
  /** True when an existing computer was adopted instead of a new one created. */
  reused?: boolean;
}

/** Owner-scoped answer to a reveal or reissue: the plaintext launch token plus
    the env and command that start the daemon with it. */
export interface ComputerTokenResponse {
  /** Install or reconnect a personal computer without an existing daemon executable. */
  installCommand?: string;
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
  userId?: string;
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
  userId: string;
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
  userId: string;
  /** Runtime node observed when the placement was created (audit only). */
  daemonNodeId: string;
  /** Current runtime node resolved through the placement's stable Computer. */
  runtimeNodeId?: string;
  /** Stable Computer identity; runtime node IDs may be replaced. */
  computerId?: string;
  managedNodeId?: string;
  nodeDisplayName?: string;
  nodeOwnership?: "managed" | "user-device" | "unknown";
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

export interface UserAgent {
  id: string;
  /** The user who supervises this agent. `/agents` is already scoped to
      the caller, and records that predate supervision carry no owner at all,
      so this is optional — an agent without one is globally assignable. */
  supervisorUserId?: string;
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
  /** False when the daemon the agent runs on is too old to pass a model on. */
  canSelectModel?: boolean;
  /** True when the agent's runtime calls a custom model endpoint on its node,
      so vendor model ids may not exist there. */
  customModelEndpoint?: boolean;
  /** Model ids this agent's runtime reports on the computers it runs on.
      Node-reported and resolved on read, like skills. */
  availableModels?: string[];
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
  /** Omitted (or `{}`) runs the runtime's default model. */
  modelPolicy?: { model?: string };
  /** A preset from `lib/presetAvatars.ts`; uploads happen after creation. */
  profileImageUrl?: string;
}

export interface CreateAgentResponse {
  agent: UserAgent;
}

export interface UserAgentsResponse {
  agents: UserAgent[];
}

export interface TeamMemberSummary {
  defaultRole?: AgentRole;
  id: string;
  displayName: string;
  profileImageUrl?: string | null;
  executorKind: AgentName;
  enabled: boolean;
  availability: LogicalAgentAvailability;
}

export interface TeamMemberConfig {
  role?: "planner" | "implementer" | "tester" | "reviewer" | "fixer";
  responsibility?: string;
  required?: boolean;
  participation?: "always" | "on_request";
  expectedOutputs?: string[];
}

export interface AgentTeam {
  collaborationStyle?: CollaborationStyle;
  id: string;
  ownerUserId: string;
  name: string;
  profileImageUrl?: string | null;
  leadAgentId?: string | null;
  memberAgentIds: string[];
  /** The computer the whole roster lives on. Absent on a team saved before
   *  teams carried one; `teamComputerId` derives it from the roster. */
  computerId?: string;
  memberConfigs?: Record<string, TeamMemberConfig>;
  acceptanceCriteria?: string[];
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
  collaborationStyle?: CollaborationStyle | null;
  memberConfigs?: Record<string, TeamMemberConfig>;
  acceptanceCriteria?: string[];
  name: string;
  leadAgentId: string;
  memberAgentIds: string[];
  /** Pins the team to one computer; every member must be placed on it. */
  computerId?: string;
  enabled?: boolean;
  /** A preset from `lib/presetAvatars.ts`; only sent when creating a team. */
  profileImageUrl?: string;
}

export interface AgentRunInput {
  style?: CollaborationStyle;
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
  style?: CollaborationStyle;
  text: string;
  intent: "accomplish" | "discuss" | "review";
  /** Agents this message addresses. Empty or absent means the whole room. */
  addressAgentIds?: string[];
  /** A team on the thread's computer that runs this round instead. Exclusive
   *  with `addressAgentIds`; the thread keeps its own team, if it has one. */
  addressTeamId?: string;
  userMessageId?: string;
  idempotencyKey?: string;
}

export interface ThreadRecoveryInput {
  kind: "rerun" | "handoff";
  targetAgentId: string;
  note?: string;
  idempotencyKey?: string;
  /** A rerun that continues the agent's own runtime conversation. */
  resume?: boolean;
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

export type UserRole = "admin" | "user";

export interface CurrentUser {
  id: string;
  username: string;
  email?: string;
  role: UserRole;
  userId?: string;
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
  userId: string;
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

export type SkillVisibility = "private" | "org";
export type SkillSource = "authored" | "upload" | "git";
export interface SkillFileInput { path: string; contentBase64: string }
export interface SkillRevision { id: string; revision: number; bytes: number; manifestSha256: string; createdAt: string; createdByUserId: string; note?: string | null }
export interface SkillFileSummary { path: string; sha256: string; bytes: number }
export interface SkillAssignment {
  id: string;
  skillId: string;
  targetType: "user" | "team" | "project" | "agent" | "org";
  targetId: string;
  mode: "optional" | "required" | "suggested";
  pin: "stable" | "latest" | { revisionId: string };
  invocation: "implicit" | "explicit";
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
}
export interface SkillRecord {
  id: string;
  ownerUserId: string;
  namespace: string;
  name: string;
  slug: string;
  displayName: string;
  description: string;
  visibility: SkillVisibility;
  source: SkillSource;
  sourceRef?: { url: string; ref: string; subpath: string } | null;
  currentRevisionId: string;
  stableRevisionId: string;
  createdAt: string;
  updatedAt: string;
  grantedAgentCount?: number;
  assignmentCount?: number;
}
export interface SkillDetail extends SkillRecord {
  revisions: SkillRevision[];
  files: SkillFileSummary[];
  grantedAgentIds: string[];
  assignments: SkillAssignment[];
}
export interface SkillsResponse { skills: SkillRecord[] }
/** One bundle file read back for preview — text only, capped server-side. */
export interface SkillFilePreview {
  path: string;
  bytes: number;
  sha256: string;
  binary: boolean;
  truncated: boolean;
  content: string;
}
