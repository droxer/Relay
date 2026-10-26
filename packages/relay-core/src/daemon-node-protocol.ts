import type { AgentName, AgentState } from "./state.js";
import type { TokenUsage } from "./token-usage.js";
import type { CodexCollaborationEvent } from "./codex-collaboration.js";
import type { WorkspaceLayout } from "./session-store.js";

export type DaemonNodeStatus = "ready" | "busy" | "stopped";
export type DaemonNodeSandboxMode = "none" | "boxlite";
export type DaemonAgentAdapter = "cli" | "service";
/**
 * What one runtime's readiness check found on a computer.
 * - `ready`: the check passed; the runtime can take work.
 * - `failed`: the CLI is installed but its check failed — it could not
 *   connect to its account or provider (not signed in, bad key, no network).
 * - `unavailable`: the CLI is not installed. A fact about the computer, not a
 *   fault.
 * - `unresponsive`: the check did not finish in time; the CLI hung.
 * A computer that stopped is not a runtime status: liveness is derived on
 * read, so a dark computer's last report stays its last report.
 */
export type DaemonAgentHealthStatus = "ready" | "failed" | "unavailable" | "unresponsive";

/** Runtime capability advertised by a daemon. Logical user agents are
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
  source?: "node" | "catalog";
  skillId?: string;
  slug?: string;
  available?: boolean;
  reason?: string;
  pin?: "latest" | { revisionId: string };
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
export type DaemonNodeCapability = "runtime-refresh" | "generated-files" | "workspace-read-shared" | "structured-agent-events" | "thread-workspaces" | "project-workspaces" | "project-workspace-delete" | "task-workspaces" | "round-result" | "work-results" | "produced-files" | "handoff-validation" | "agent-skills" | "agent-model" | "endpoint-models" | "execution-journal-report" | "agent-resume" | "project-setup" | "project-links" | "artifact-layout" | "dot-thread-records" | "relay-thread-records";
/** The daemon can materialize and isolate skill revisions attached to a run. */
export const DAEMON_CAPABILITY_AGENT_SKILLS: DaemonNodeCapability = "agent-skills";
/** Checks recorded handoff hashes under the workspace gate before starting an agent. */
export const DAEMON_CAPABILITY_HANDOFF_VALIDATION: DaemonNodeCapability = "handoff-validation";
export const DAEMON_CAPABILITY_GENERATED_FILES: DaemonNodeCapability = "generated-files";
/** The daemon can serve live file listings and reads from the workspace root it exposes. */
export const DAEMON_CAPABILITY_WORKSPACE_READ_SHARED: DaemonNodeCapability = "workspace-read-shared";
/** The daemon emits normalized nested-agent lifecycle events in addition to raw output. */
export const DAEMON_CAPABILITY_STRUCTURED_AGENT_EVENTS: DaemonNodeCapability = "structured-agent-events";
/** The daemon executes each thread below its configured node workspace root. */
export const DAEMON_CAPABILITY_THREAD_WORKSPACES: DaemonNodeCapability = "thread-workspaces";
/** The daemon can map multiple threads onto one validated project directory. */
export const DAEMON_CAPABILITY_PROJECT_WORKSPACES: DaemonNodeCapability = "project-workspaces";
/**
 * A project may link an existing directory on the computer (`links/<id>`
 * workspace subpaths). The daemon validates each one against roots configured
 * locally, through `workspace.link` and the registration response's `projectLinks`.
 */
export const DAEMON_CAPABILITY_PROJECT_LINKS: DaemonNodeCapability = "project-links";
/**
 * The daemon honours `artifactsDir` on `run.start`: an automation's
 * occurrences share one directory with per-run `artifacts/<taskId>/`, and a
 * project workspace holds its deliverables itself, with no `artifacts/`.
 */
export const DAEMON_CAPABILITY_ARTIFACT_LAYOUT: DaemonNodeCapability = "artifact-layout";
export const DAEMON_CAPABILITY_DOT_THREAD_RECORDS: DaemonNodeCapability = "dot-thread-records";
/** Thread records under `.relay/threads/`, moved there from `.threads/` and `threads/`. */
export const DAEMON_CAPABILITY_RELAY_THREAD_RECORDS: DaemonNodeCapability = "relay-thread-records";
/** The daemon can map every round of one task onto a single validated task directory. */
export const DAEMON_CAPABILITY_TASK_WORKSPACES: DaemonNodeCapability = "task-workspaces";
/**
 * The daemon reads the control file a run leaves at `.relay/round-result.json`
 * and reports it as `roundResult`, so the control plane learns whether the work
 * is finished without parsing the agent's prose.
 */
export const DAEMON_CAPABILITY_WORK_RESULTS: DaemonNodeCapability = "work-results";
/** The daemon passes `AgentState.agent_model` to the runtime CLI's model flag. */
export const DAEMON_CAPABILITY_AGENT_MODEL: DaemonNodeCapability = "agent-model";
/**
 * A runtime behind a custom model endpoint reports only the models that
 * endpoint lists, never its vendor's ids, so its options can be offered as is.
 */
export const DAEMON_CAPABILITY_ENDPOINT_MODELS: DaemonNodeCapability = "endpoint-models";
export const DAEMON_CAPABILITY_ROUND_RESULT: DaemonNodeCapability = "round-result";
/**
 * At registration the daemon names the runs it admitted before a restart and
 * will not resume (`journaledCommandIds`), so the backend can mark them
 * interrupted instead of guessing the start never arrived.
 */
export const DAEMON_CAPABILITY_EXECUTION_JOURNAL_REPORT: DaemonNodeCapability = "execution-journal-report";
/** Terminal events carry `runtimeSessionId`, and `AgentState.resume_session_id` resumes it. */
export const DAEMON_CAPABILITY_AGENT_RESUME: DaemonNodeCapability = "agent-resume";
/**
 * The daemon reads the proposal a project setup round leaves at
 * `.relay/project-setup-<runId>.json` and reports it as `projectSetup`; the backend
 * validates it and the project owner decides whether to apply it.
 */
export const DAEMON_CAPABILITY_PROJECT_SETUP: DaemonNodeCapability = "project-setup";
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
  /** Untrusted, bounded agent report; the conductor validates its semantics. */
  work?: Record<string, unknown>;
  status: "done" | "continue" | "blocked";
  note?: string;
  /** Answers a blocked round offers its human to pick from. */
  options?: string[];
  /** Lines a project run proposes for the project's standing context; the owner adopts or dismisses them. */
  contextSuggestions?: Array<{ text: string; evidence?: string }>;
}

/**
 * Why the daemon refused a round-result file the run did leave behind. A
 * missing file is not a rejection; it is simply no verdict.
 */
export type DaemonRoundResultRejectionReason =
  | "oversize"
  | "malformed"
  | "not_object"
  | "invalid_status"
  | "run_id_mismatch";

/** A present verdict the daemon refused, so the human's question cannot vanish silently. */
export interface DaemonRoundResultRejection {
  reason: DaemonRoundResultRejectionReason;
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

export interface DaemonRunSkillBundle {
  contract: { name: "relay.agent.skills"; version: 1 };
  skills: Array<{
    skillId: string;
    revisionId: string;
    slug: string;
    manifestSha256: string;
    assignmentMode?: "optional" | "required";
    files: Array<{ path: string; sha256: string; bytes: number }>;
  }>;
}

export interface DaemonSkippedSkill {
  skillId: string;
  slug?: string;
  reason: string;
  assignmentMode?: "optional" | "required";
}

export interface DaemonNodeRegistration {
  runtimeRefreshCommands?: Array<{ commandId: string; leaseId: string }>;
  /** Runs admitted before a daemon restart that this daemon will not resume. */
  journaledCommandIds?: string[];
  sandboxId: string;
  userId?: string;
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
  /** Runtimes whose model calls go to a custom endpoint, not the vendor API. */
  customModelEndpoints?: AgentName[];
  /** Model ids each runtime itself offers on this node, in the runtime's order. */
  agentModels?: Partial<Record<AgentName, string[]>>;
  maxConcurrentRuns?: number;
  status?: DaemonNodeStatus;
}

/**
 * What a backend's heartbeat understands. `poll-liveness`: an open command
 * poll already renews liveness and leases, so a daemon may skip beats while
 * one is in flight. `state`: the heartbeat body may carry `state`.
 */
export type DaemonNodeHeartbeatFeature = "poll-liveness" | "state";

export type DaemonNodeHeartbeatState = "ready" | "draining" | "stopped";

export interface DaemonNodeHeartbeatSettings {
  /** Recommended renewal cadence chosen by the backend. */
  intervalMs: number;
  /** Time since the last accepted observation before the node is offline. */
  timeoutMs: number;
  /** Absent on an older backend, which then needs a beat during every poll. */
  features?: DaemonNodeHeartbeatFeature[];
  /** Backend timestamp for the accepted renewal. */
  observedAt?: string;
  commandLeases?: Array<{ commandId: string; leaseId?: string; leaseExpiresAt: string }>;
  /** Submitted runs Relay already holds a terminal outcome for (reported gone). */
  settledCommandIds?: string[];
}

export interface DaemonNodeHeartbeat {
  activeCommandLeases: Array<{ commandId: string; leaseId?: string }>;
  leaseSeconds?: number;
  /** `draining`: still alive for its runs, but will not poll again; `stopped`: gone. */
  state?: DaemonNodeHeartbeatState;
}

export interface DaemonNodeRegistrationResponse {
  heartbeat?: DaemonNodeHeartbeatSettings;
  /** Journaled runs the backend has accounted for; the daemon may forget them. */
  acknowledgedJournalIds?: string[];
  /** Every linked project directory on this computer; replaces the daemon's map. */
  projectLinks?: DaemonProjectLink[];
}

/** A project's `links/<id>` workspace subpath and the existing directory it names. */
export interface DaemonProjectLink {
  workspaceSubpath: string;
  hostPath: string;
}

export type DaemonProjectLinkErrorCode =
  | "invalid-path"
  | "not-found"
  | "not-directory"
  | "not-allowed"
  | "not-writable"
  | "protected";

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
  reportExecutionStarted?: boolean;
  handoffValidation?: {
    contract: { name: "relay.handoff.validation"; version: 1 };
    assignmentId: string;
    workspaceLayout: DaemonWorkspaceLayout;
    workspaceSubpath: string | null;
    artifacts: Array<{ artifactId: string; path: string; sha256: string | null }>;
  };
  workspacePath?: string;
  /** Missing means node-root for compatibility with commands from older backends. */
  workspaceLayout?: DaemonWorkspaceLayout;
  /** Required when workspaceLayout is project. */
  workspaceSubpath?: string;
  /**
   * Workspace-relative deliverables directory. `null` means the workspace
   * itself is the deliverable location (a project); missing means an older
   * backend, which expects `artifacts/`.
   */
  artifactsDir?: string | null;
  state?: AgentState;
  skills?: DaemonRunSkillBundle;
  skillsSkipped?: DaemonSkippedSkill[];
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

export interface DaemonWorkspaceDeleteCommand {
  id: string;
  type: "workspace.delete";
  leaseId?: string;
  leaseExpiresAt?: string;
  attempt?: number;
  sessionId: string;
  workspaceLayout: "project";
  workspaceSubpath: string;
  path: "";
}

/** Validates an existing directory and, unless `dryRun`, links it to `workspaceSubpath`. */
export interface DaemonProjectLinkCommand {
  id: string;
  type: "workspace.link";
  leaseId?: string;
  leaseExpiresAt?: string;
  attempt?: number;
  workspaceSubpath: string;
  hostPath: string;
  dryRun?: boolean;
}

export type DaemonWorkspaceErrorCode =
  | "invalid-path"
  | "not-found"
  | "is-directory"
  | "io-error"
  | Exclude<DaemonProjectLinkErrorCode, "invalid-path" | "not-found">;

export type DaemonNodeCommand = { id: string; type: "runtime.refresh"; leaseId: string } | DaemonNodeRunCommand | DaemonNodeCancelCommand | DaemonWorkspaceListCommand | DaemonWorkspaceReadCommand | DaemonWorkspaceDeleteCommand | DaemonProjectLinkCommand;

/** Longest tool input, in characters, a permission request carries. */
export const PERMISSION_INPUT_LIMIT = 4000;

/** Most questions one prompt may carry; the backend refuses more. */
export const PERMISSION_QUESTIONS_LIMIT = 4;
/** Most offered answers per question. */
export const PERMISSION_OPTIONS_LIMIT = 8;
/** Longest question text, option label, or free-text answer. */
export const PERMISSION_TEXT_LIMIT = 500;

/**
 * One question a runtime's "ask the user" tool poses mid-run (Claude's
 * AskUserQuestion, Codex's request_user_input, Kimi's AskUserQuestion). The
 * person picks from `options` or writes an answer; `multiSelect` allows
 * several picks.
 */
export interface PermissionQuestionItem {
  /** The runtime's own key for the question; answers are keyed by it. */
  id: string;
  text: string;
  options: Array<{ label: string; description?: string }>;
  multiSelect?: boolean;
}

/** A person's answers, by question id; each a non-empty list of labels or free text. */
export type PermissionAnswers = Record<string, string[]>;

/** One tool use a runtime wants a person to approve. */
export interface DaemonPermissionRequest {
  /** Daemon-minted id, `perm_<hex>`; the poll route names it. */
  id: string;
  toolName: string;
  toolUseId?: string;
  /** The tool input as JSON, capped at PERMISSION_INPUT_LIMIT characters. */
  input: string;
  /** Set when the tool is a question for the person rather than an action. */
  questions?: PermissionQuestionItem[];
}

/** Answer to `GET /daemon-nodes/{id}/permission-requests/{requestId}`. */
export interface DaemonPermissionDecision {
  status: "pending" | "allow" | "deny" | "expired";
  note?: string;
  /** The person's answers to a question prompt, on `allow`. */
  answers?: PermissionAnswers;
}

export type DaemonNodeEvent =
  | { type: "workspace.deleted"; commandId: string; leaseId?: string; path: string }
  /** `hostPath` is the directory's canonical path on the computer. */
  | { type: "workspace.linked"; commandId: string; leaseId?: string; path: ""; hostPath: string }
  | {
      type: "run.executing";
      commandId: string;
      leaseId?: string;
      sessionId: string;
      runId: string;
      agent: AgentName;
      skillsSkipped?: DaemonSkippedSkill[];
    }
  | {
      /** A local run's runtime asked to use a tool; a person decides in Relay. */
      type: "run.permission_requested";
      commandId: string;
      leaseId?: string;
      sessionId: string;
      runId: string;
      agent: AgentName;
      request: DaemonPermissionRequest;
    }
  | {
      /** The run stopped waiting on a prompt (its runtime gave up, or the
       *  daemon's deadline passed), so the prompt closes as expired. */
      type: "run.permission_withdrawn";
      commandId: string;
      leaseId?: string;
      sessionId: string;
      runId: string;
      agent: AgentName;
      requestId: string;
      reason: string;
    }
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
      /** Set instead of `roundResult` when the run left a verdict file the daemon refused. */
      roundResultRejected?: DaemonRoundResultRejection;
      /** Follow-up requests the run suggested for its person (`next-steps.ts`); bounded, untrusted. */
      nextSteps?: string[];
      /** A setup round's proposal as the agent wrote it; the backend validates it. */
      projectSetup?: Record<string, unknown>;
      /** The backend rejected at least one output batch; the streamed log has gaps. */
      outputTruncated?: boolean;
      /** The runtime CLI's own conversation id, for a later resume. */
      runtimeSessionId?: string;
    }
  | {
      /** A stopped run's process exit cannot be verified; it stays reserved. */
      type: "run.exit_unconfirmed";
      commandId: string;
      leaseId?: string;
      sessionId: string;
      runId: string;
      agent: AgentName;
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
      /** Usage the agent process reported before the run failed. */
      tokenUsage?: TokenUsage;
      /** Files written by an otherwise successful agent process before output delivery failed. */
      generatedFiles?: DaemonGeneratedFile[];
      /** The runtime CLI's own conversation id, for a later resume. */
      runtimeSessionId?: string;
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
      /** Usage the agent process reported before it was stopped. */
      tokenUsage?: TokenUsage;
      /** The runtime CLI's own conversation id, for a later resume. */
      runtimeSessionId?: string;
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
