import type { AgentName, AgentState } from "./state.js";
import type { TokenUsage } from "./token-usage.js";
import type { CodexCollaborationEvent } from "./codex-collaboration.js";
import type { WorkspaceLayout } from "./session-store.js";

export type DaemonNodeStatus = "ready" | "busy" | "stopped";
export type DaemonNodeSandboxMode = "none" | "boxlite";
export type DaemonAgentAdapter = "cli" | "service";
export type DaemonAgentHealthStatus = "ready" | "failed";

/** Runtime capability advertised by a daemon. Logical employee agents are
 * control-plane identities and are connected to these capabilities by placements. */
export interface DaemonExecutorCapability {
  executorKind: AgentName;
  status: DaemonAgentHealthStatus;
  adapter: DaemonAgentAdapter;
  maxConcurrentRuns: number;
  inventory?: DaemonAgentInventory;
  configurationFingerprint?: string;
}

export interface DaemonAgentHealth {
  status: DaemonAgentHealthStatus;
  detail?: string;
  version?: string;
  adapter?: DaemonAgentAdapter;
}

export type DaemonMcpTransport = "stdio" | "sse" | "http";

/** A SKILL.md directory installed in an agent's home inside the node. */
export interface DaemonAgentSkill {
  name: string;
  namespace?: string;
  description?: string;
}

/** An MCP server configured for an agent CLI inside the node. */
export interface DaemonAgentMcpServer {
  name: string;
  transport: DaemonMcpTransport;
  command?: string;
}

/** What an agent CLI actually has installed inside the node. */
export interface DaemonAgentInventory {
  skills: DaemonAgentSkill[];
  mcpServers: DaemonAgentMcpServer[];
}

/** Version 2 adds ordered run.output.batch delivery. */
export const DAEMON_NODE_PROTOCOL_VERSION = 2 as const;
/** The backend remains able to receive legacy version-1 run.output events. */
export const DAEMON_NODE_SUPPORTED_PROTOCOL_VERSIONS: readonly number[] = [2, 1];

/**
 * Daemon-advertised optional behaviors. "generated-files" means the daemon
 * detects document-type files created or changed by a run and reports them
 * in its run.completed event, so the backend never has to walk the workspace
 * itself (which only works when they share a filesystem).
 */
export type DaemonNodeCapability = "generated-files" | "workspace-read-shared" | "structured-agent-events" | "thread-workspaces" | "project-workspaces" | "task-workspaces" | "round-result" | "produced-files";
export const DAEMON_CAPABILITY_GENERATED_FILES: DaemonNodeCapability = "generated-files";
/** The daemon can serve live file listings and reads from the workspace root it exposes. */
export const DAEMON_CAPABILITY_WORKSPACE_READ_SHARED: DaemonNodeCapability = "workspace-read-shared";
/** The daemon emits normalized nested-agent lifecycle events in addition to raw output. */
export const DAEMON_CAPABILITY_STRUCTURED_AGENT_EVENTS: DaemonNodeCapability = "structured-agent-events";
/** The daemon executes each thread below its configured node workspace root. */
export const DAEMON_CAPABILITY_THREAD_WORKSPACES: DaemonNodeCapability = "thread-workspaces";
/** The daemon can map multiple threads onto one validated project directory. */
export const DAEMON_CAPABILITY_PROJECT_WORKSPACES: DaemonNodeCapability = "project-workspaces";
/** The daemon can map every round of one task onto a single validated task directory. */
export const DAEMON_CAPABILITY_TASK_WORKSPACES: DaemonNodeCapability = "task-workspaces";
/**
 * The daemon reads the control file a run leaves at `.relay/round-result.json`
 * and reports it as `roundResult`, so the control plane learns whether the work
 * is finished without parsing the agent's prose.
 */
export const DAEMON_CAPABILITY_ROUND_RESULT: DaemonNodeCapability = "round-result";
/**
 * "produced-files" means the daemon reports every file a run changed, not only
 * document types, and states why any file arrived without a snapshot. A daemon
 * without it reports the older document-only set, which the backend still
 * indexes unchanged.
 */
export const DAEMON_CAPABILITY_PRODUCED_FILES: DaemonNodeCapability = "produced-files";

/**
 * A round's own verdict on the task, reported by the daemon from the control
 * file the run left behind. "continue" asks for another round; "blocked" ends
 * the work and needs a human; "done" is the finished case.
 */
export interface DaemonRoundResult {
  status: "done" | "continue" | "blocked";
  note?: string;
}

/**
 * Why a reported file arrived without bytes attached.
 *
 * "too-large" covers both the per-file cap and an exhausted per-event budget;
 * a reader only needs to know the size limits stopped it. "unreadable" means
 * the file vanished or could not be read between the walk and the read.
 */
export type SnapshotSkippedReason =
  | "too-large"
  | "not-snapshotable-type"
  | "sensitive"
  | "unreadable";

/** A workspace file a run created or changed, reported by the daemon. */
export interface DaemonGeneratedFile {
  /** Path relative to the run workspace (thread child or legacy node root). */
  relativePath: string;
  title: string;
  bytes: number;
  contentType: string;
  /**
   * Base64 file content for files small enough to snapshot, so the backend
   * can serve the artifact even without access to the daemon's filesystem
   * and after the workspace copy is deleted or rewritten.
   */
  contentBase64?: string;
  /**
   * Set when no snapshot was attached, so the record can say the file is
   * attributed but live-only rather than simply appearing to be missing.
   * Absent whenever `contentBase64` is present.
   */
  snapshotSkipped?: SnapshotSkippedReason;
}

export interface DaemonNodeRegistration {
  sandboxId: string;
  employeeId?: string;
  token: string;
  workspacePath?: string;
  workspaceId?: string;
  sandboxMode?: DaemonNodeSandboxMode;
  protocolVersion: number;
  supportedAgents: AgentName[];
  executorCapabilities?: DaemonExecutorCapability[];
  capabilities?: DaemonNodeCapability[];
  agentHealth?: Partial<Record<AgentName, DaemonAgentHealth>>;
  agentInventory?: Partial<Record<AgentName, DaemonAgentInventory>>;
  maxConcurrentRuns?: number;
  status?: DaemonNodeStatus;
}

export interface DaemonNodeHeartbeatSettings {
  /** Recommended renewal cadence chosen by the backend. */
  intervalMs: number;
  /** Time since the last accepted observation before the node is offline. */
  timeoutMs: number;
  /** Backend timestamp for the accepted renewal. */
  observedAt?: string;
}

export interface DaemonNodeHeartbeat {
  activeCommandLeases: Array<{ commandId: string; leaseId?: string }>;
}

export interface DaemonNodeRegistrationResponse {
  heartbeat?: DaemonNodeHeartbeatSettings;
}

export interface DaemonNodeHeartbeatResponse {
  heartbeat: DaemonNodeHeartbeatSettings;
}

/** Legacy sessions stay at the node root; newly-created sessions use a thread child. */
export type DaemonWorkspaceLayout = WorkspaceLayout;

export interface DaemonNodeRunCommand {
  id: string;
  type: "run.start";
  leaseId?: string;
  leaseExpiresAt?: string;
  attempt?: number;
  sessionId: string;
  runId: string;
  taskGoal: string;
  agent: AgentName;
  logicalAgentId?: string;
  placementId?: string;
  agentVersion?: number;
  assignmentId?: string;
  phase?: "discussion" | "execution" | "review";
  role?: "implementer" | "reviewer" | "planner" | "tester" | "fixer";
  delivery?: {
    type: "assignment-attempt";
    attemptId: string;
    collaborationId: string;
    roundId: string;
    assignmentId: string;
    workItemId?: string;
  };
  reportWorkspaceStatus?: boolean;
  workspacePath?: string;
  /** Missing means node-root for compatibility with commands from older backends. */
  workspaceLayout?: DaemonWorkspaceLayout;
  /** Required when workspaceLayout is project. */
  workspaceSubpath?: string;
  state?: AgentState;
}

export interface DaemonNodeCancelCommand {
  id: string;
  type: "run.cancel";
  leaseId?: string;
  leaseExpiresAt?: string;
  attempt?: number;
  commandId: string;
  sessionId: string;
  runId: string;
  agent: AgentName;
  reason: string;
}

export interface DaemonWorkspaceEntry {
  name: string;
  path: string;
  kind: "directory" | "file";
  bytes: number | null;
  updatedAt: string;
}

export interface DaemonWorkspaceListCommand {
  id: string;
  type: "workspace.list";
  leaseId?: string;
  leaseExpiresAt?: string;
  attempt?: number;
  /** Thread workspace to read. Omitted only for node-root administration. */
  sessionId?: string;
  workspaceLayout?: DaemonWorkspaceLayout;
  workspaceSubpath?: string;
  path: string;
}

export interface DaemonWorkspaceReadCommand {
  id: string;
  type: "workspace.read";
  leaseId?: string;
  leaseExpiresAt?: string;
  attempt?: number;
  /** Thread workspace to read. Omitted only for node-root administration. */
  sessionId?: string;
  workspaceLayout?: DaemonWorkspaceLayout;
  workspaceSubpath?: string;
  path: string;
}

export type DaemonWorkspaceErrorCode = "invalid-path" | "not-found" | "is-directory" | "io-error";

export type DaemonNodeCommand = DaemonNodeRunCommand | DaemonNodeCancelCommand | DaemonWorkspaceListCommand | DaemonWorkspaceReadCommand;

export type DaemonNodeEvent =
  | {
      type: "run.workspace";
      commandId: string;
      leaseId?: string;
      sessionId: string;
      runId: string;
      agent: AgentName;
      waiting: boolean;
      blockingSessionId?: string;
    }
  | {
      type: "run.output";
      commandId: string;
      leaseId?: string;
      sessionId: string;
      runId: string;
      agent: AgentName;
      stream: "stdout" | "stderr";
      text: string;
      sequence: number;
    }
  | {
      type: "run.output.batch";
      commandId: string;
      leaseId?: string;
      sessionId: string;
      runId: string;
      agent: AgentName;
      entries: Array<{
        stream: "stdout" | "stderr";
        text: string;
        sequence: number;
      }>;
    }
  | {
      type: "run.collaboration";
      commandId: string;
      leaseId?: string;
      sessionId: string;
      runId: string;
      agent: AgentName;
      collaboration: CodexCollaborationEvent;
      sequence: number;
    }
  | {
      type: "run.completed";
      commandId: string;
      leaseId?: string;
      sessionId: string;
      runId: string;
      agent: AgentName;
      exitCode: number;
      agentLog: string;
      tokenUsage?: TokenUsage;
      generatedFiles?: DaemonGeneratedFile[];
      roundResult?: DaemonRoundResult;
    }
  | {
      type: "run.failed";
      commandId: string;
      leaseId?: string;
      sessionId: string;
      runId: string;
      agent: AgentName;
      error: string;
      agentLog?: string;
      exitCode?: number;
      /** Files written by an otherwise successful agent process before output delivery failed. */
      generatedFiles?: DaemonGeneratedFile[];
    }
  | {
      type: "run.cancelled";
      commandId: string;
      leaseId?: string;
      sessionId: string;
      runId: string;
      agent: AgentName;
      reason: string;
      agentLog?: string;
    }
  | {
      type: "workspace.listing";
      commandId: string;
      leaseId?: string;
      agentId?: string;
      path: string;
      exists: boolean;
      entries: DaemonWorkspaceEntry[];
    }
  | {
      type: "workspace.file";
      commandId: string;
      leaseId?: string;
      agentId?: string;
      path: string;
      bytes: number;
      isBinary: boolean;
      truncated: boolean;
      contentBase64?: string;
    }
  | {
      type: "workspace.error";
      commandId: string;
      leaseId?: string;
      agentId?: string;
      path: string;
      code: DaemonWorkspaceErrorCode;
      message: string;
    };
