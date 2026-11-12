import { createBackendFetch } from './backend-fetch.js';
import { executeCommand } from './run-execution.js';
import { commandLogFields, commandLeaseEventFields } from './run-events.js';
import {
  DaemonHttpError,
  DaemonStoppedError,
  requestSignal,
  withBackendReconnect,
  postJson,
  postJsonResponse,
  postJsonRequest,
  postJsonWithRetry,
  getJson,
  eventPostRetryLogger,
  delay,
} from './backend-transport.js';
export { DaemonHttpError, backendReconnectDelayMs } from './backend-transport.js';
import { superviseBackgroundTask } from './background-task.js';
import { RunSupervisor } from './run-supervisor.js';
import { resourceLimit, parseRuntimeLimits, type RuntimeLimits, type AdmissionWaitReason } from "./run-admission.js";
import { DaemonLogWriter, type DaemonLogWriterOptions } from "./daemon-log-writer.js";
import { AdmissionLedger } from "./admission-ledger.js";
import { withExecutionDeadline } from "./execution-deadline.js";
import { syncDirectory } from "./sync-directory.js";
import { retryAfterMs } from "./transport-retry.js";
import { ReportStoragePolicy } from "./report-storage.js";
import { TransportMonitor } from "./transport-monitor.js";
import { DiagnosticsSchedule } from "./diagnostics-schedule.js";
import { CommandTasks } from "./command-tasks.js";
import { assertRunWorkspaceScope, durableWorkspaceLayout, requiredWorkspaceSubpath } from "./run-workspace.js";
import { RELAY_CLIENT_VERSION } from "./client-version.js";
import { createHash } from "node:crypto";
import type { StreamRenderer } from "relay-core";
import { formatDaemonLog } from "./daemon-log-format.js";
import { err, out } from "./terminal-style.js";
import { legacyUserId, userIdFromEnv } from "./legacy-names.js";
import { loadManagedEnrollment, saveManagedEnrollment } from "./managed-enrollment.js";
import { createLocalRuntime, localProcessExecStream } from "./local-runtime.js";
import { AgentNotInstalledError, AgentUnresponsiveError } from "./agent-preflight.js";
import { responseErrorDetail, transportErrorDetail } from "./http-error-detail.js";
export { localProcessExecStream } from "./local-runtime.js";
import {
  accessSync,
  closeSync,
  fsyncSync,
  openSync,
  writeFileSync,
  renameSync,
  chmodSync,
  constants,
  mkdirSync,
  statSync,
  statfsSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type {
  DaemonNodeCommand,
  DaemonNodeEvent,
  DaemonAgentHealth,
  DaemonNodeHeartbeat,
  DaemonNodeHeartbeatFeature,
  DaemonNodeHeartbeatResponse,
  DaemonNodeHeartbeatSettings,
  DaemonNodeHeartbeatState,
  DaemonNodeRegistration,
  DaemonNodeRegistrationResponse,
  DaemonNodeRunCommand,
  DaemonNodeSandboxMode,
  AgentName,
} from "relay-core";
import {
  startOrchestratorSession,
  ensureAgentReady as ensureSandboxAgentReady,
  probeAgentReadiness,
  resolveBoxliteHome,
  BoxliteRuntimeOwner,
} from "./sandbox-session.js";
import { GuestPool, type GuestLease } from "./guest-pool.js";
import { discoverAgentInventory } from "./agent-inventory.js";
import { discoverAgentModels, type ProviderListMemory } from "./agent-models.js";
import { BoxLiteExecutionManager, type ExecutionManager } from "./execution.js";
import { ensureLocalDevboxOci, hasHostKimiCodeAuth, prepareHostAgentSkills, prepareHostKimiCodeHome } from "./box.js";

async function verifyBoxlitePrerequisites(sandboxId: string): Promise<void> {
  try {
    await import("@boxlite-ai/boxlite");
  } catch {
    console.error(err.error(`Relay daemon requires @boxlite-ai/boxlite to run in boxlite sandbox mode.`));
    console.error(`Run: ${err.command("npm install")}`);
    process.exit(1);
  }
  try {
    ensureLocalDevboxOci((text) => console.log(`  ${text.trimEnd()}`));
  } catch (error) {
    console.error(err.error(`Failed to prepare BoxLite devbox image for sandbox ${sandboxId}:`));
    console.error(transportErrorDetail(error));
    console.error(`Run: ${err.command("make devbox-oci")}`);
    process.exit(1);
  }
}
import {
  AGENT_NAMES,
  getAgent,
  ensureDaemonNodeToken,
  readDaemonNodeToken,
  ensureMachineId,
  GUEST_WORKSPACE,
  customModelEndpointAgents,
  DAEMON_NODE_PROTOCOL_VERSION,
  daemonHostOs,
  relayApiUrl,
} from "relay-core";
import { DAEMON_ADVERTISED_CAPABILITIES } from "./capabilities.js";
import { workspaceReply } from "./workspace-commands.js";
import { ThreadWorkspaceManager } from "./thread-workspace.js";
import { configuredProjectRoots, ProjectLinkRegistry } from "./project-links.js";
import { ExecutionWatchdog } from "./execution-watchdog.js";
import { ExecutionJournal } from "./execution-journal.js";
import { acknowledgeUpdatePause } from "./update-pause.js";
import { TerminalOutbox } from "./terminal-outbox.js";
import { retireStaleGuests, type GuestRuntime } from "./exit-proof.js";
import type { ExecutionRecord } from "./execution-journal.js";
import { WorkspaceRunGate } from "./workspace-run-gate.js";
import { bootstrapRelayMcp, createMcpReconciler, configureRelayMcp } from "./relay-mcp-bootstrap.js";

export type DaemonSandboxMode = DaemonNodeSandboxMode;
const DEFAULT_DAEMON_SANDBOX_MODE: DaemonSandboxMode = "boxlite";
/** Runs one daemon executes at once; override with RELAY_DAEMON_MAX_CONCURRENT_RUNS. */
export const DEFAULT_MAX_CONCURRENT_RUNS = 5;

export interface DaemonRuntimeOptions {
  backendUrl?: string;
  sandboxId?: string;
  /**
   * How agent CLIs are executed: "boxlite" boots a BoxLite VM owned by this
   * daemon and runs agents inside the guest; "none" runs them as local
   * processes (for daemons that already live inside a sandbox).
   */
  sandbox?: DaemonSandboxMode;
  /** Explicit acknowledgement required before running agents as host processes. */
  allowHostAgentExecution?: boolean;
  userId?: string;
  workspacePath?: string;
  workspaceId?: string;
  pollIntervalMs?: number;
  commandPollWaitMs?: number;
  commandLeaseSeconds?: number;
  /**
   * How long a run may outlive its expired lease while the backend cannot be
   * reached at all (network errors or 5xx). 0 disables the grace.
   */
  unreachableGraceMs?: number;
  /** How often the daemon renews its liveness lease. The backend-advertised
   * cadence is used by default. */
  livenessHeartbeatIntervalMs?: number;
  /** How often capabilities and local agent inventory are re-registered. */
  heartbeatIntervalMs?: number;
  inventoryDiscoveryTimeoutMs?: number;
  fetchFn?: typeof fetch;
  token?: string;
  enrollmentToken?: string;
  /** Daemon-private credentials and logs. This directory must never be mounted into an agent sandbox. */
  stateDir?: string;
  /** Roots a project may link an existing directory beneath; defaults to `configuredProjectRoots`. */
  projectRoots?: string[];
  logDir?: string;
  logger?: DaemonLogger;
  signal?: AbortSignal;
  shutdownGraceMs?: number;
  /** Bound on the final "stopped" registration; defaults to SHUTDOWN_REGISTRATION_TIMEOUT_MS. */
  shutdownRegistrationTimeoutMs?: number;
  /** How often a host run left over from a previous daemon is checked again for exit; defaults to EXIT_RECHECK_INTERVAL_MS. */
  exitRecheckIntervalMs?: number;
  agentHome?: string;
  maxConcurrentRuns?: number;
  maxGuests?: number;
  maxConcurrentBoots?: number;
  runtimeLimits?: RuntimeLimits;
  environment?: DaemonExecutionEnvironment;
  preflight?: boolean;
  /** Echo rendered agent output to the daemon's own stdout/stderr. Defaults
   * to true; RELAY_DAEMON_ECHO_AGENT_OUTPUT overrides. Supervisors disable it
   * so their logs carry lifecycle events only, not full agent responses. */
  echoAgentOutput?: boolean;
}

export type DaemonHealthState = "starting" | "registered" | "polling" | "busy" | "stopping" | "stopped";

export interface DaemonDoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface DaemonDoctorReport {
  ok: boolean;
  checks: DaemonDoctorCheck[];
}

export interface DaemonLogFields {
  sandboxId?: string;
  commandId?: string;
  sessionId?: string;
  runId?: string;
  agent?: AgentName;
  stream?: "stdout" | "stderr";
  sequence?: number;
  exitCode?: number;
  text?: string;
  error?: string;
  [key: string]: unknown;
}

export interface DaemonLogger {
  readonly logPath?: string;
  info(message: string, fields?: DaemonLogFields): void;
  warn(message: string, fields?: DaemonLogFields): void;
  error(message: string, fields?: DaemonLogFields): void;
  output(fields: DaemonLogFields & { text: string; stream: "stdout" | "stderr" }): void;
  /** Wait until asynchronously buffered log writes have reached the filesystem. */
  flush?(): Promise<void>;
  close?(): Promise<void>;
}

export async function runRelayDaemon(options: DaemonRuntimeOptions = {}): Promise<void> {
  const backendUrl = normalizeBaseUrl(options.backendUrl ?? process.env.RELAY_BACKEND_URL ?? process.env.RELAY_DAEMON_URL ?? "http://127.0.0.1:8790");
  let transportLogger = options.logger;
  let rawFetch = options.fetchFn ?? createBackendFetch(recovery => {
    transportLogger?.warn(recovery.protocol === 'http/1.1'
      ? 'Repeated HTTP/2 failures; falling back to HTTP/1.1 until restart'
      : 'HTTP/2 transport failed; retrying with a fresh connection pool', { sandboxId, ...recovery });
  });
  let fetchFn = rawFetch;
  let sandboxId = options.sandboxId ?? process.env.RELAY_SANDBOX_ID;
  let configuredUserId = options.userId ?? userIdFromEnv();
  const userId = configuredUserId ?? process.env.USER ?? "local";
  const workspacePath = firstNonBlank(options.workspacePath, process.env.RELAY_WORKSPACE, process.env.WORKSPACE) ?? process.cwd();
  // Identify the computer by a stable per-host machine id, not the working
  // directory. Relaunching the daemon from a different path (or booting a fresh
  // sandbox) must resolve to the same computer, otherwise every launch mints a
  // duplicate compatibility agent. An explicit workspaceId/RELAY_WORKSPACE_ID
  // still wins for callers that manage identity themselves.
  const workspaceId =
    firstNonBlank(options.workspaceId, process.env.RELAY_WORKSPACE_ID) ??
    ensureMachineId().machineId;
  const enrollmentToken = options.enrollmentToken ?? process.env.RELAY_ENROLLMENT_TOKEN;
  let enrolledToken: string | undefined;
  let enrolledSandboxMode: string | undefined;
  let enrolledHeartbeatSettings: DaemonNodeHeartbeatSettings | undefined;
  if (!sandboxId && enrollmentToken) {
    // A grant identifies one provisioning attempt. Keying the private bootstrap
    // state by backend + grant avoids reusing an identity for another attempt.
    const enrollmentKey = createHash("sha256").update(JSON.stringify([backendUrl, enrollmentToken])).digest("hex");
    const enrollmentDir = resolveDaemonStateDirectory(`enrollment-${enrollmentKey}`, options.stateDir);
    const enrollmentPath = join(enrollmentDir, `enrollment-${enrollmentKey}.json`);
    const enrollment = loadManagedEnrollment(enrollmentPath) ?? await withBackendReconnect(
      () => enrollManagedDaemon(fetchFn, backendUrl, enrollmentToken, workspacePath, options.signal),
      options.logger ?? { warn: () => undefined },
      { sandboxId: "pending-managed-enrollment", what: "managed enrollment" },
      { signal: options.signal },
    );
    saveManagedEnrollment(enrollmentPath, enrollment);
    sandboxId = enrollment.sandboxId;
    enrolledToken = enrollment.token;
    configuredUserId = configuredUserId ?? legacyUserId(enrollment);
    enrolledSandboxMode = enrollment.sandboxMode;
    enrolledHeartbeatSettings = validHeartbeatSettings(enrollment.heartbeat);
  }
  if (!sandboxId) throw new Error("RELAY_SANDBOX_ID or RELAY_ENROLLMENT_TOKEN is required for the relay daemon.");
  const effectiveUserId = configuredUserId ?? userId;
  const sandboxMode = resolveSandboxMode(options.sandbox ?? process.env.RELAY_SANDBOX_MODE ?? enrolledSandboxMode);
  if (!options.environment) {
    assertHostAgentExecutionAllowed(
      sandboxMode,
      options.allowHostAgentExecution ?? process.env.RELAY_ALLOW_HOST_AGENT_EXECUTION === "1",
    );
  }
  const stateDir = resolveDaemonStateDirectory(sandboxId, options.stateDir);
  const logger = options.logger ?? createDaemonLogger({ workspacePath, sandboxId, logDir: options.logDir ?? join(stateDir, "logs") });
  let reportPersistenceFault = false;
  let pollAbort: AbortController | undefined;
  let recoveryPollPending = false;
  let monitor: TransportMonitor | undefined;
  try { monitor = new TransportMonitor(stateDir); } catch { reportPersistenceFault = true; }
  const observe = (action: () => void): void => {
    try { action(); } catch { reportPersistenceFault = true; }
  };
  transportLogger = logger;
  const upstreamFetch = rawFetch;
  rawFetch = async (url, init) => {
    const path = new URL(typeof url === 'string' ? url : url instanceof URL ? url : url.url).pathname;
    const batch = path.endsWith('/reports');
    const channel = path.endsWith('/commands') ? 'poll' : path.endsWith('/events') || batch ? 'output' : path.endsWith('/heartbeat') ? 'heartbeat' : path.endsWith('/daemon-node-registrations') ? 'registration' : undefined;
    try {
      const response = await upstreamFetch(url, init);
      if (channel) observe(() => {
        if (response.ok) {
          // Batch HTTP success alone proves nothing about its individual
          // reports. The outbox clears this channel on verified receipts.
          if (batch) return;
          const headers = new Headers(init?.headers);
          const verified = channel !== 'output' || !heartbeatFeatures.has('durable-reports') ||
            (response.headers.get('X-Relay-Report-Id') === headers.get('X-Relay-Report-Id') && response.headers.get('X-Relay-Report-Digest') === headers.get('X-Relay-Report-Digest'));
          if (verified) monitor?.success(channel); else monitor?.failure(channel);
        }
        else if (response.status >= 500 || [408, 429].includes(response.status)) monitor?.failure(channel);
        else if (channel !== 'output' && [401, 410].includes(response.status)) monitor?.cause('revoked', true);
      });
      return response;
    } catch (error) {
      if (channel && !options.signal?.aborted) observe(() => monitor?.failure(channel));
      throw error;
    }
  };
  // Set while execution endpoints fail transiently; cleared by an ownership
  // response or a 401/410 rejection. Registration alone cannot renew a run.
  let backendUnreachable = false;
  let heartbeatFeatures = new Set<DaemonNodeHeartbeatFeature>();
  let pollInFlightSince: number | undefined;
  let sendDrainingHeartbeat: (() => Promise<void>) | undefined;
  let sendStoppedHeartbeat: (() => Promise<void>) | undefined;
  const configuredUnreachableGraceMs = options.unreachableGraceMs
    ?? nonNegativeSecondsEnv("RELAY_DAEMON_UNREACHABLE_GRACE_SECONDS");
  const unreachableGraceMs = configuredUnreachableGraceMs ?? DEFAULT_UNREACHABLE_GRACE_MS;
  const executionWatchdog = new ExecutionWatchdog(undefined, {
    graceMs: unreachableGraceMs,
    continueDuringOutage: configuredUnreachableGraceMs === undefined,
    shouldGrace: () => backendUnreachable,
    onGrace: (commandId) => logger.warn("Execution lease expired while the backend is unreachable; continuing for one grace period", {
      sandboxId, commandId, graceMs: unreachableGraceMs,
    }),
  });
  let supervisor: RunSupervisor;
  const executionJournal = new ExecutionJournal(join(stateDir, "executions"));
  const terminalOutbox = new TerminalOutbox(join(stateDir, "terminal-events"), (id) => {
    executionJournal.confirmExit(id);
    // Only live run promises need a terminal marker for capacity/lease bookkeeping.
    // Orphan cancellation acknowledgements must not grow a lifetime in-memory set.
    supervisor?.terminalStored(id);
    unconfirmedExecutions.delete(id);
    executionWatchdog.forget(id);
  }, positiveIntEnv("RELAY_DAEMON_REPORT_STORAGE_BYTES"), (error) => {
    reportPersistenceFault = true;
    // Failed writes have no durable acceptance proof. Protect execution and
    // preserve the bounded capture for diagnosis.
    logger.warn("durable output record write failed", { sandboxId, error: error.message });
  });
  terminalOutbox.setAcceptanceHandler(() => observe(() => monitor?.success('output')));
  // A crash may land between durable terminal storage and journal removal.
  for (const record of terminalOutbox.terminalRecords()) {
    if (["run.completed", "run.failed", "run.cancelled"].includes(String(record.event.type))) executionJournal.confirmExit(String(record.event.commandId));
  }
  const unconfirmedExecutions = new Set(executionJournal.pending().map(record => record.id));
  // Retained executions the backend has not yet accounted for. Reported at
  // registration until acknowledged; unconfirmedExecutions keeps fencing them.
  const unreportedExecutions = new Set(unconfirmedExecutions);
  const admittedExecutions = new AdmissionLedger(join(stateDir, "admissions"));
  for (const id of [...unconfirmedExecutions, ...terminalOutbox.commandIds()]) admittedExecutions.add(id);
  fetchFn = terminalOutbox.wrapFetch(rawFetch);
  configureAgentProcessEnvironment(sandboxMode, workspacePath, options.agentHome);
  const tokenResolution = ensureDaemonNodeToken({
    credentialDirectory: join(stateDir, "credentials"),
    legacyWorkspacePath: workspacePath,
    userId: effectiveUserId,
    token: options.token ?? process.env.RELAY_DAEMON_TOKEN ?? process.env.RELAY_DAEMON_NODE_TOKEN ?? enrolledToken,
  });
  const token = tokenResolution.token;
  const pollIntervalMs = options.pollIntervalMs ?? 1000;
  const echoAgentOutput = options.echoAgentOutput ?? booleanEnv("RELAY_DAEMON_ECHO_AGENT_OUTPUT") ?? true;
  const commandPollWaitMs = boundedNumber(
    options.commandPollWaitMs ?? positiveIntEnv("RELAY_DAEMON_COMMAND_POLL_WAIT_MS") ?? DEFAULT_COMMAND_POLL_WAIT_MS,
    0,
    MAX_COMMAND_POLL_WAIT_MS,
  );
  const commandLeaseSeconds = boundedNumber(
    options.commandLeaseSeconds
      ?? positiveIntEnv("RELAY_DAEMON_COMMAND_LEASE_SECONDS")
      ?? DEFAULT_COMMAND_LEASE_SECONDS,
    1,
    MAX_COMMAND_LEASE_SECONDS,
  );
  const registrationRefreshIntervalMs = options.heartbeatIntervalMs ?? positiveIntEnv("RELAY_DAEMON_HEARTBEAT_MS") ?? positiveIntEnv("RELAY_DAEMON_NODE_HEARTBEAT_MS") ?? 5 * 60_000;
  const configuredLivenessHeartbeatIntervalMs = options.livenessHeartbeatIntervalMs
    ?? positiveIntEnv("RELAY_DAEMON_LIVENESS_HEARTBEAT_MS");
  const inventoryDiscoveryTimeoutMs = options.inventoryDiscoveryTimeoutMs ?? positiveIntEnv("RELAY_DAEMON_INVENTORY_TIMEOUT_MS") ?? 10_000;
  const maxConcurrentRuns = resourceLimit('RELAY_DAEMON_MAX_CONCURRENT_RUNS',
    options.maxConcurrentRuns ?? process.env.RELAY_DAEMON_MAX_CONCURRENT_RUNS, DEFAULT_MAX_CONCURRENT_RUNS);
  const maxGuests = resourceLimit('RELAY_DAEMON_MAX_GUESTS',
    options.maxGuests ?? process.env.RELAY_DAEMON_MAX_GUESTS, maxConcurrentRuns);
  const maxConcurrentBoots = resourceLimit('RELAY_DAEMON_MAX_CONCURRENT_BOOTS',
    options.maxConcurrentBoots ?? process.env.RELAY_DAEMON_MAX_CONCURRENT_BOOTS, maxGuests);
  const runtimeLimits = parseRuntimeLimits(options.runtimeLimits === undefined
    ? process.env.RELAY_DAEMON_RUNTIME_LIMITS : JSON.stringify(options.runtimeLimits));
  const environment = options.environment
    ?? createExecutionEnvironment(sandboxMode, sandboxId, workspacePath, logger, maxGuests, maxConcurrentBoots);
  if (sandboxMode === "boxlite" && !options.environment) {
    await verifyBoxlitePrerequisites(sandboxId);
  }
  const projectLinks = new ProjectLinkRegistry(
    options.projectRoots ?? configuredProjectRoots(environment.sandboxMode),
    [workspacePath, stateDir, join(homedir(), ".relay")],
  );
  const threadWorkspaces = new ThreadWorkspaceManager(workspacePath, environment.sandboxMode, projectLinks);
  const workspaceRunGate = new WorkspaceRunGate(threadWorkspaces.rootPath);
  let health: DaemonHealthState | undefined;
  const setHealth = (next: DaemonHealthState, fields: DaemonLogFields = {}): void => {
    if (health === next) return;
    health = next;
    logger.info("daemon health", { sandboxId, health: next, ...fields });
  };
  logger.info("daemon starting", { sandboxId, userId: effectiveUserId, workspacePath, backendUrl, sandboxMode });
  // Runs the machine proves ended are settled with that evidence instead of
  // waiting for a person. They stay fenced: none of them is ever run again.
  const provenExits = await proveJournaledExits(environment, executionJournal.pending(), logger, sandboxId);
  for (const record of provenExits) unreportedExecutions.delete(record.id);
  // A host run can outlive its daemon (a killed daemon never stops its
  // process groups), and usually ends soon after. Those are checked again
  // while this daemon runs; a BoxLite check retires guests, so it runs once.
  let leftoverExecutions = executionJournal.pending()
    .filter((execution) => !provenExits.some((record) => record.id === execution.id));
  for (const execution of leftoverExecutions) {
    logger.warn("Execution exit unconfirmed after daemon restart; retained identity requires reconciliation", {
      sandboxId, commandId: execution.id, runId: execution.runId,
      sessionId: execution.sessionId, leaseId: execution.leaseId,
      ...(environment.sandboxMode === "none" ? {
        evidence: execution.processGroup ? `process group ${execution.processGroup} still running` : "no process group recorded",
      } : {}),
    });
  }
  leftoverExecutions = environment.sandboxMode === "none"
    ? leftoverExecutions.filter((execution) => execution.processGroup)
    : [];
  const exitRecheckIntervalMs = options.exitRecheckIntervalMs ?? EXIT_RECHECK_INTERVAL_MS;
  setHealth("starting", { userId: effectiveUserId, workspacePath, backendUrl, sandboxMode });
  supervisor = new RunSupervisor({
    journal: executionJournal, ledger: admittedExecutions, watchdog: executionWatchdog,
    workspaceGate: workspaceRunGate, maxConcurrentRuns, runtimeLimits,
    leaseDurationMs: commandLeaseSeconds * 1000, sandboxId, logger,
    report: (event, command, signal) => postJsonWithRetry(fetchFn,
      relayApiUrl(backendUrl, `/daemon-nodes/${encodeURIComponent(sandboxId)}/events`), event, token,
      signal.aborted ? (stopping ? AbortSignal.timeout(shutdownRegistrationTimeoutMs) : runtimeSignal) : signal,
      eventPostRetryLogger(logger, { ...commandLogFields(sandboxId, command), eventType: event.type })),
    exitUnconfirmed: command => postJsonWithRetry(fetchFn,
      relayApiUrl(backendUrl, `/daemon-nodes/${encodeURIComponent(sandboxId)}/events`), {
        type: 'run.exit_unconfirmed', commandId: command.id, ...commandLeaseEventFields(command),
        sessionId: command.sessionId, runId: command.runId, agent: command.agent,
      } satisfies DaemonNodeEvent, token, runtimeSignal),
    onIdle: () => { if (!stopping) setHealth('polling'); },
  });
  const shutdownGraceMs = options.shutdownGraceMs ?? positiveIntEnv("RELAY_DAEMON_SHUTDOWN_GRACE_MS") ?? 10_000;
  const shutdownRegistrationTimeoutMs = options.shutdownRegistrationTimeoutMs ?? SHUTDOWN_REGISTRATION_TIMEOUT_MS;
  const shutdownController = new AbortController();
  const runtimeSignal = options.signal
    ? AbortSignal.any([options.signal, shutdownController.signal])
    : shutdownController.signal;
  let stopping = false;
  let shutdownPromise: Promise<void> | undefined;
  // Set when the backend answers 410: the node was deleted in the control
  // panel, so this daemon stops instead of re-registering itself back in.
  let credentialsRejected = false;
  if (runtimeSignal.aborted) {
    setHealth("stopping", { signal: "external" });
    await environment.close();
    setHealth("stopped");
    await logger.close?.();
    return;
  }
  let agentHealth = await discoverDaemonAgentHealth(environment, logger, sandboxId, options.signal);
  let agentInventory = await discoverAgentInventory(environment.execStream, options.signal, inventoryDiscoveryTimeoutMs);
  const providerModelLists: ProviderListMemory = new Map();
  let agentDefaultModels: Partial<Record<AgentName, string>> = {};
  let agentModels = await discoverAgentModels(environment.execStream, readyAgents(agentHealth), options.signal, inventoryDiscoveryTimeoutMs, providerModelLists, agentDefaultModels);
  const runtimeRefreshCommands = new Map<string, string>();
  let refreshedCommands: Array<{ commandId: string; leaseId: string }> = [];
  const hostOs = daemonHostOs(process.platform);
  const buildRegistration = (includeUserId = Boolean(configuredUserId), status?: DaemonNodeRegistration["status"]): DaemonNodeRegistration => ({
    sandboxId,
    ...(includeUserId ? { userId: effectiveUserId } : {}),
    token,
    workspacePath,
    ...(workspaceId ? { workspaceId } : {}),
    sandboxMode,
    ...(hostOs ? { hostOs } : {}),
    protocolVersion: DAEMON_NODE_PROTOCOL_VERSION,
    clientVersion: RELAY_CLIENT_VERSION,
    supportedAgents: readyAgents(agentHealth),
    executorCapabilities: Object.entries(agentHealth).map(([executorKind, health]) => ({
      executorKind: executorKind as AgentName,
      status: health.status,
      adapter: health.adapter ?? "cli",
      maxConcurrentRuns: Math.min(maxConcurrentRuns, runtimeLimits[executorKind as AgentName] ?? maxConcurrentRuns),
      ...(agentInventory[executorKind as AgentName] ? { inventory: agentInventory[executorKind as AgentName] } : {}),
    })),
    runtimeRefreshCommands: refreshedCommands,
    ...(unreportedExecutions.size > 0 ? { journaledCommandIds: [...unreportedExecutions].slice(0, JOURNAL_REPORT_LIMIT) } : {}),
    capabilities: [...DAEMON_ADVERTISED_CAPABILITIES],
    agentHealth,
    ...(Object.keys(agentInventory).length > 0 ? { agentInventory } : {}),
    customModelEndpoints: customModelEndpointAgents(),
    agentModels,
    agentDefaultModels,
    maxConcurrentRuns,
    status: status ?? (supervisor.size > 0 ? "busy" : "ready"),
  });
  const reconcileMcp = createMcpReconciler(runtimes => bootstrapRelayMcp({ home: homedir(), stateDir, sandboxId, backendUrl,
    nodeToken: token, runtimes, fetchFn, signal: runtimeSignal }));
  let lastMcpStatus = "";
  const refreshMcp = async () => {
    if (options.environment || sandboxMode !== "none" || stopping) return;
    const status = await reconcileMcp(readyAgents(agentHealth));
    const key = JSON.stringify(status);
    if (key === lastMcpStatus) return;
    lastMcpStatus = key;
    try { (await import("./relay-mcp-install.js")).privateWrite(join(stateDir,"mcp-status.json"),key); }
    catch { logger.warn("Could not persist Relay MCP setup status", {sandboxId}); }
    if (status.status === "ready") logger.info("Relay MCP ready", {runtimes:status.runtimes});
    else logger.warn("Relay MCP setup needs attention; it will reconcile again", {status:status.status,code:status.code});
  };
  let registeredComputerId: string | undefined;
  const register = async (): Promise<DaemonNodeHeartbeatSettings | undefined> => {
    const url = relayApiUrl(backendUrl, "/daemon-node-registrations");
    const response = await postJsonResponse<DaemonNodeRegistrationResponse>(
      fetchFn, url, buildRegistration(), undefined, runtimeSignal,
    );
    registeredComputerId = response.computerId;
    for (const id of response.acknowledgedJournalIds ?? []) {
      // Acknowledgement accounts for the interrupted run, but is not exit
      // evidence. Keep its journal so another restart can still prove exit;
      // the durable terminal outbox removes it once that proof is recorded.
      unreportedExecutions.delete(id);
    }
    if (Array.isArray(response.projectLinks)) {
      for (const rejected of projectLinks.replaceAll(response.projectLinks)) {
        logger.warn("linked project directory refused", { sandboxId, ...rejected });
      }
    }
    void refreshMcp();
    return validHeartbeatSettings(response.heartbeat);
  };
  if (options.preflight !== false) {
    await runStartupPreflight({ backendUrl, sandboxId, token, workspacePath, fetchFn, logger, signal: runtimeSignal });
  }
  const shutdown = (signal: NodeJS.Signals | "external", exitProcess: boolean): void => {
    shutdownPromise ??= (async () => {
      stopping = true;
      supervisor.closeAdmission();
      if (!shutdownController.signal.aborted) shutdownController.abort(`Daemon received ${signal}.`);
      setHealth("stopping", { signal });
      logger.info("daemon stopping", { sandboxId, signal });
      // Tell the backend first that no more work will be taken, so nothing is
      // dispatched into the drain and lost; the runs below keep their leases.
      if (!credentialsRejected && heartbeatFeatures.has("state")) {
        await sendDrainingHeartbeat?.();
      }
      supervisor.stopAll(`Daemon received ${signal}.`);
      await Promise.race([
        supervisor.settle(),
        delay(shutdownGraceMs),
      ]);
      // A deleted node has no record to mark stopped, and the backend rejects
      // the registration anyway. Skip it rather than log a bogus failure.
      if (!credentialsRejected) {
        // One small beat says "stopped" where the backend understands it; an
        // older backend still needs the full registration to learn the fact.
        const stopNotice = heartbeatFeatures.has("state") && sendStoppedHeartbeat
          ? sendStoppedHeartbeat()
          : postJson(
            fetchFn,
            relayApiUrl(backendUrl, "/daemon-node-registrations"),
            buildRegistration(undefined, "stopped"),
            undefined,
            AbortSignal.timeout(shutdownRegistrationTimeoutMs),
          );
        await stopNotice.catch((error: unknown) => {
          logger.warn("daemon stopped notice failed", { sandboxId, error: transportErrorDetail(error) });
        });
      }
      await environment.close();
      setHealth("stopped");
      await logger.close?.();
      if (exitProcess) process.exit(0);
    })();
  };
  const handleSigint = (): void => shutdown("SIGINT", true);
  const handleSigterm = (): void => shutdown("SIGTERM", true);
  // Closing the terminal a daemon runs in hangs it up. Left to Node's default
  // that kills the daemon outright, while each run's own process group keeps
  // going with nobody to stop or report it; stop the runs like any shutdown.
  const handleSighup = (): void => shutdown("SIGHUP", true);
  const handleExternalAbort = (): void => shutdown("external", false);
  const cleanupShutdownListeners = (): void => {
    process.off("SIGINT", handleSigint);
    process.off("SIGTERM", handleSigterm);
    process.off("SIGHUP", handleSighup);
    options.signal?.removeEventListener("abort", handleExternalAbort);
  };
  process.once("SIGINT", handleSigint);
  process.once("SIGTERM", handleSigterm);
  process.once("SIGHUP", handleSighup);
  options.signal?.addEventListener("abort", handleExternalAbort, { once: true });
  if (options.signal?.aborted) shutdown("external", false);
  if (stopping) {
    try {
      await shutdownPromise;
    } finally {
      cleanupShutdownListeners();
    }
    return;
  }
  const storagePolicy = new ReportStoragePolicy(
    positiveIntEnv('RELAY_DAEMON_REPORT_FREE_ADMISSION_BYTES'),
    positiveIntEnv('RELAY_DAEMON_REPORT_FREE_STOP_BYTES'),
    positiveIntEnv('RELAY_DAEMON_REPORT_FREE_RESUME_BYTES'),
  );
  let storageDecision = { admit: true, stop: false };
  const protectStorage = (): void => {
    let freeBytes = 0;
    try { const disk = statfsSync(stateDir); freeBytes = disk.bavail * disk.bsize; } catch { reportPersistenceFault = true; }
    const status = terminalOutbox.status();
    storageDecision = storagePolicy.update({ ...status, bytes: status.quotaExceeded ? Math.max(status.bytes, status.limitBytes * 0.9) : status.bytes, freeBytes, online: !backendUnreachable, persistenceFault: status.persistenceFault || reportPersistenceFault });
    observe(() => {
      monitor?.cause('storage', !storageDecision.admit);
      monitor?.cause('quarantine', status.quarantined > 0);
      monitor?.cause('execution', unconfirmedExecutions.size > 0);
    });
    if (storageDecision.stop) supervisor.stopAll('Report storage protection stopped this run; retained reports are preserved.', false);
  };
  terminalOutbox.setPressureHandler(protectStorage);
  protectStorage();
  const storageTimer = setInterval(protectStorage, 100);
  storageTimer.unref();
  const watchdogTimer = setInterval(() => executionWatchdog.tick(), 1000);
  watchdogTimer.unref();
  let heartbeatTask: Promise<void> | undefined;
  let outboxTask: Promise<void> | undefined;
  let exitRecheckTask: Promise<void> | undefined;
  let diagnosticsTask: Promise<void> | undefined;
  const commandTasks = new CommandTasks(runtimeSignal, (error, key) => {
    logger.error("background command failed; unacknowledged work will retry", { sandboxId, key, error: String(error) });
  });
  let backgroundRuntimeRefresh: Promise<void> | undefined;
  try {
    const reconnectControl = {
      signal: runtimeSignal,
      shouldStop: () => stopping,
      onTransientFailure: () => { backendUnreachable = true; if (heartbeatFeatures.has("durable-reports")) pollAbort?.abort("Transport recovery probe superseded a stalled poll."); },
      onCredentialRejected: () => { backendUnreachable = false; },
    };
    const initialHeartbeatSettings = await withBackendReconnect(
      register, logger, { sandboxId, what: "registration" }, reconnectControl,
    );
    let livenessHeartbeatIntervalMs = configuredLivenessHeartbeatIntervalMs
      ?? initialHeartbeatSettings?.intervalMs
      ?? enrolledHeartbeatSettings?.intervalMs
      ?? DEFAULT_LIVENESS_HEARTBEAT_MS;
    heartbeatFeatures = new Set(initialHeartbeatSettings?.features ?? enrolledHeartbeatSettings?.features ?? []);
    terminalOutbox.negotiate(heartbeatFeatures.has("durable-reports"), heartbeatFeatures.has("report-batches"));
    let lastRegisteredAt = Date.now();
    const reportProvenExit = (record: ExecutionRecord, reason: string): void => {
      // Persisted to the outbox before sending, so delivery survives another
      // restart; the outbox clears the journal record once it holds the event.
      void postJsonWithRetry(fetchFn, relayApiUrl(backendUrl, `/daemon-nodes/${encodeURIComponent(sandboxId)}/events`), {
        type: "run.cancelled",
        commandId: record.id,
        ...(record.leaseId ? { leaseId: record.leaseId } : {}),
        sessionId: record.sessionId,
        runId: record.runId,
        agent: record.agent as AgentName,
        reason,
      } satisfies DaemonNodeEvent, token, runtimeSignal).catch((error: unknown) => {
        logger.warn("proven-exit report failed; the outbox will retry", {
          sandboxId, commandId: record.id, error: transportErrorDetail(error),
        });
      });
    };
    for (const record of provenExits) {
      reportProvenExit(record, "The computer restarted, and this run's process had already stopped.");
    }
    exitRecheckTask = (async () => {
      while (leftoverExecutions.length > 0 && !runtimeSignal.aborted) {
        await delay(exitRecheckIntervalMs, runtimeSignal);
        const exited = await proveJournaledExits(environment, leftoverExecutions, logger, sandboxId);
        for (const record of exited) {
          // Not yet acknowledged means not yet reported: the cancel says it all.
          unreportedExecutions.delete(record.id);
          reportProvenExit(record, "The computer restarted while this run was going; its process has since stopped.");
        }
        leftoverExecutions = leftoverExecutions.filter((execution) => !exited.some((record) => record.id === execution.id));
      }
    })().catch((error: unknown) => {
      if (!runtimeSignal.aborted) logger.warn("leftover run check stopped", { sandboxId, error: String(error) });
    });
    logger.info("daemon registered", { sandboxId, userId: effectiveUserId, workspacePath, backendUrl, logPath: logger.logPath });
    setHealth("registered");
    console.log(`${out.success(`Relay daemon registered sandbox ${sandboxId}`)} ${out.muted(`with backend at ${backendUrl} (sandbox: ${sandboxMode})`)}`);
    if (logger.logPath) console.log(`${out.muted("Relay daemon log:")} ${out.command(logger.logPath)}`);
    if (tokenResolution.source === "generated" && tokenResolution.path) {
      logger.info("daemon generated token", { sandboxId, userId: effectiveUserId, path: tokenResolution.path });
      console.log(`${out.muted(`Relay daemon generated token for ${effectiveUserId}:`)} ${out.command(tokenResolution.path)}`);
    }

    setHealth("polling");
    const updateHeartbeatSettings = (settings: DaemonNodeHeartbeatSettings | undefined): void => {
      if (!settings) return;
      if (configuredLivenessHeartbeatIntervalMs === undefined) {
        livenessHeartbeatIntervalMs = settings.intervalMs;
      }
      heartbeatFeatures = new Set(settings.features ?? []);
      terminalOutbox.negotiate(heartbeatFeatures.has("durable-reports"), heartbeatFeatures.has("report-batches"));
    };
    const backendHeartbeatSupports = (feature: DaemonNodeHeartbeatFeature): boolean => heartbeatFeatures.has(feature);
    // While a command poll is open on a backend that renews liveness and
    // leases from it, a beat would only repeat what the poll already says.
    // A poll held past its own wait is not trusted to be doing that.
    const pollRenewsLiveness = (): boolean => backendHeartbeatSupports("poll-liveness")
      && pollInFlightSince !== undefined
      && performance.now() - pollInFlightSince < commandPollWaitMs;
    const renewExecutionLeases = (settings: DaemonNodeHeartbeatSettings | undefined, sentAt: number): void => {
      // A run the backend already settled while this daemon could not verify
      // its exit was reported gone by a person; only that frees its slot.
      for (const commandId of settings?.settledCommandIds ?? []) {
        supervisor.reconcile(commandId);
      }
      if (!settings?.commandLeases) return;
      const observedAt = Date.parse(settings.observedAt ?? "");
      for (const lease of settings.commandLeases) {
        if (supervisor.commands(true).find(command => command.id === lease.commandId)?.leaseId !== lease.leaseId) continue;
        const duration = Date.parse(lease.leaseExpiresAt) - observedAt - (performance.now() - sentAt);
        if (Number.isFinite(duration)) executionWatchdog.renew(lease.commandId, duration, observedAt);
      }
    };
    const activeCommandLeases = () => [
      ...supervisor.commands(true).map(command => ({ commandId: command.id, leaseId: command.leaseId })),
      ...commandTasks.leases(),
      ...[...runtimeRefreshCommands].map(([commandId, leaseId]) => ({ commandId, leaseId })),
    ].slice(0, 50);
    const sendHeartbeat = async (state?: DaemonNodeHeartbeatState, signal: AbortSignal = runtimeSignal): Promise<void> => {
      const sentAt = performance.now();
      const renewing = supervisor.commands(true).map(command => ({ command }));
      const url = relayApiUrl(backendUrl, `/daemon-nodes/${encodeURIComponent(sandboxId)}/heartbeat`);
      try {
        const response = await postJsonResponse<DaemonNodeHeartbeatResponse>(
          fetchFn,
          url,
          {
            leaseSeconds: commandLeaseSeconds,
            activeCommandLeases: activeCommandLeases(),
            ...(state ? { state } : {}),
          } satisfies DaemonNodeHeartbeat,
          token,
          // A beat gets one interval, never the shared request timeout: a
          // request that black-holes must not hold the schedule past the
          // liveness window it exists to renew.
          AbortSignal.any([signal, AbortSignal.timeout(heartbeatRequestTimeoutMs())]),
        );
        updateHeartbeatSettings(validHeartbeatSettings(response.heartbeat));
        if (response.heartbeat.commandLeases) {
          renewExecutionLeases(response.heartbeat, sentAt);
        } else {
          // Older backends acknowledge the submitted leases implicitly.
          for (const { command } of renewing) executionWatchdog.renew(command.id,
            commandLeaseSeconds * 1000 - (performance.now() - sentAt));
        }
        if (backendUnreachable && heartbeatFeatures.has('durable-reports')) {
          recoveryPollPending = true;
          pollAbort?.abort('Healthy heartbeat requests an immediate recovery poll.');
        }
        backendUnreachable = false;
      } catch (error) {
        // Rolling upgrades may briefly put a new daemon behind an older
        // backend. Registration remains the compatibility heartbeat.
        if (error instanceof DaemonHttpError && error.status === 404) {
          updateHeartbeatSettings(await register());
          lastRegisteredAt = Date.now();
          return;
        }
        throw error;
      }
    };
    const shutdownBeat = (state: DaemonNodeHeartbeatState) => async (): Promise<void> => {
      // Not the runtime signal: it is already aborted while we drain.
      await sendHeartbeat(state, AbortSignal.timeout(shutdownRegistrationTimeoutMs)).catch((error: unknown) => {
        logger.warn(`daemon ${state} heartbeat failed`, { sandboxId, error: transportErrorDetail(error) });
        if (state === "stopped") throw error;
      });
    };
    sendDrainingHeartbeat = shutdownBeat("draining");
    sendStoppedHeartbeat = shutdownBeat("stopped");
    // The periodic runtime re-check runs beside the command poll, never in
    // front of it, so a command arriving during the probes (seconds on a
    // local computer) is not held up. Runtimes in use keep their last report:
    // probing them would touch the credentials the running agent is using. A
    // BoxLite node probes inside a guest that is already up and, while busy,
    // skips the round while none is.
    const refreshIdleRuntimesInBackground = async (): Promise<void> => {
      const inUse = new Set(supervisor.commands().map(command => command.agent));
      const idle = AGENT_NAMES.filter((agent) => !inUse.has(agent));
      const keepInUse = <T>(fresh: Partial<Record<AgentName, T>>, prior: Partial<Record<AgentName, T>>) => ({
        ...Object.fromEntries(Object.entries(fresh).filter(([agent]) => !inUse.has(agent as AgentName))),
        ...Object.fromEntries(Object.entries(prior).filter(([agent]) => inUse.has(agent as AgentName))),
      }) as Partial<Record<AgentName, T>>;
      const signal = AbortSignal.any([runtimeSignal, AbortSignal.timeout(BUSY_RUNTIME_REFRESH_TIMEOUT_MS)]);
      const commands = [...runtimeRefreshCommands].slice(0, 50);
      try {
        const health = await discoverDaemonAgentHealth(environment, logger, sandboxId, signal, idle, agentHealth);
        const inventory = await discoverAgentInventory(environment.execStream, signal, inventoryDiscoveryTimeoutMs);
        const defaults: Partial<Record<AgentName, string>> = {};
        const models = await discoverAgentModels(environment.execStream, readyAgents(health), signal, inventoryDiscoveryTimeoutMs, providerModelLists, defaults);
        if (signal.aborted || stopping) return;
        agentHealth = { ...agentHealth, ...health };
        agentInventory = keepInUse(inventory, agentInventory);
        agentModels = keepInUse(models, agentModels);
        agentDefaultModels = keepInUse(defaults, agentDefaultModels);
        refreshedCommands = commands.map(([commandId, leaseId]) => ({ commandId, leaseId }));
        updateHeartbeatSettings(await register());
      } catch (error) {
        logger.warn("busy runtime refresh failed; it will retry", {
          sandboxId, error: transportErrorDetail(error),
        });
      } finally {
        refreshedCommands = [];
        // A failed attempt waits out the interval instead of retrying every
        // poll; an unacknowledged refresh request is redelivered once its
        // lease lapses.
        for (const [commandId, leaseId] of commands) {
          if (runtimeRefreshCommands.get(commandId) === leaseId) runtimeRefreshCommands.delete(commandId);
        }
        lastRegisteredAt = Date.now();
      }
    };
    const diagnosticsSchedule = new DiagnosticsSchedule();
    diagnosticsTask = (async () => {
      while (!runtimeSignal.aborted) {
        try {
          const snapshot = { ...monitor?.snapshot(), ...terminalOutbox.status(), runs: [...new Set(supervisor.commands().map(command => command.runId).concat(executionJournal.pending().map(run => run.runId)))].slice(0, 200) };
          writePrivateDiagnostic(join(stateDir, 'transport-diagnostics.json'), snapshot);
          if (heartbeatFeatures.has('transport-status') && diagnosticsSchedule.due(snapshot, performance.now())) {
            await postJsonRequest(rawFetch, relayApiUrl(backendUrl, `/daemon-nodes/${encodeURIComponent(sandboxId)}/transport`), snapshot, token, runtimeSignal);
            diagnosticsSchedule.sent(snapshot, performance.now());
          }
        } catch (error) {
          if (!runtimeSignal.aborted && diagnosticsSchedule.failed(performance.now(), error instanceof DaemonHttpError ? error.retryAfterMs : 0)) logger.warn('Transport diagnostics retained locally; delivery will retry', { sandboxId, error: transportErrorDetail(error) });
        }
        await delay(1000, runtimeSignal);
      }
    })().catch(() => undefined);
    outboxTask = superviseBackgroundTask("terminal replay", runtimeSignal, async () => {
      while (!runtimeSignal.aborted) {
        await terminalOutbox.replay(rawFetch, relayApiUrl(backendUrl, `/daemon-nodes/${encodeURIComponent(sandboxId)}/events`), token, runtimeSignal);
        await delay(50 + Math.random() * 50, runtimeSignal);
      }
    }, error => {
      logger.error("terminal replay stopped; draining daemon", { error: transportErrorDetail(error) });
      shutdown("external", false);
    });
    const heartbeatPeriodMs = (): number => Math.min(livenessHeartbeatIntervalMs, commandLeaseSeconds * 1000 / 3);
    const heartbeatRequestTimeoutMs = (): number => Math.max(MIN_HEARTBEAT_REQUEST_TIMEOUT_MS, heartbeatPeriodMs());
    heartbeatTask = superviseBackgroundTask("liveness heartbeat", runtimeSignal, async () => {
      // Fixed rate with jitter, one attempt per tick. A failed beat is not
      // retried inside the tick: the next tick is the retry, so a retry never
      // waits longer than a beat, and a fleet started together drifts apart.
      let nextBeatAt = performance.now() + heartbeatPeriodMs();
      while (!stopping && !runtimeSignal.aborted) {
        await delay(Math.max(0, nextBeatAt - performance.now()), runtimeSignal);
        nextBeatAt = performance.now() + jittered(heartbeatPeriodMs());
        if (stopping || runtimeSignal.aborted) return;
        if (pollRenewsLiveness() && !heartbeatFeatures.has("durable-reports")) continue;
        try {
          await sendHeartbeat();
        } catch (error) {
          if (stopping || runtimeSignal.aborted) return;
          if (error instanceof DaemonHttpError && (error.status === 401 || error.status === 410)) {
            reconnectControl.onCredentialRejected();
            throw error;
          }
          const transient = !(error instanceof DaemonHttpError)
            || error.status >= 500 || error.status === 408 || error.status === 429;
          // Only an unreachable backend starts an execution grace; a refusal
          // the backend itself answered is logged and tried again next beat.
          if (transient) reconnectControl.onTransientFailure();
          if (error instanceof DaemonHttpError) nextBeatAt = Math.max(nextBeatAt, performance.now() + error.retryAfterMs);
          logger.warn("liveness heartbeat failed; next beat retries", {
            sandboxId, error: transportErrorDetail(error),
          });
        }
      }
    }, (error: unknown) => {
      if (stopping || runtimeSignal.aborted || error instanceof DaemonStoppedError) return;
      if (error instanceof DaemonHttpError && (error.status === 401 || error.status === 410)) {
        credentialsRejected = true;
        logger.info("daemon credentials rejected; run setup again", { sandboxId, status: error.status });
        shutdown("external", false);
        return;
      }
      logger.error("liveness heartbeat stopped; draining daemon", {
        sandboxId,
        error: transportErrorDetail(error),
      });
      shutdown("external", false);
    });
    // Capacity refusals attest non-execution and may be retried by a negotiated
    // backend; other refusals fail in place. The post is never allowed
    // to throw into the poll loop: an event the backend refuses (409, or a 401
    // from a stale lease) is about that run, not this daemon's credential, so
    // it must not stop the daemon.
    const queueReport = (event: Extract<DaemonNodeEvent, { type: "run.failed" | "run.cancelled" }>, failureMessage: string, fields: DaemonLogFields): void => {
      if (terminalOutbox.quarantined(event.commandId, event.leaseId)) return;
      // Capture terminal evidence even when every background sender is busy.
      // The outbox replays reports that cannot enter the bounded task queue.
      try { terminalOutbox.retain({ ...event }); }
      catch (error) {
        logger.error(failureMessage, { ...fields, error: transportErrorDetail(error) });
        protectStorage();
        return;
      }
      commandTasks.submit(JSON.stringify(["report", event.commandId, event.leaseId ?? null]), async () => {
        try {
          await postJsonWithRetry(fetchFn, relayApiUrl(backendUrl, `/daemon-nodes/${encodeURIComponent(sandboxId)}/events`),
            event, token, runtimeSignal);
        } catch (error) {
          const rejection = terminalOutbox.quarantined(event.commandId, event.leaseId);
          if (!rejection) throw error;
          logger.error('report quarantined; automatic retries paused', {
            ...fields, reportId: rejection.reportId, status: rejection.status,
            error: rejection.detail, recovery: 'Inspect relay reports; stop the daemon before relay retry-report.',
          });
        }
      });
    };
    const postRejectedStart = (command: DaemonNodeRunCommand, detail: string, reason?: AdmissionWaitReason): void => {
      // Refused ids remain fenced even if capacity opens before redelivery.
      admittedExecutions.add(command.id);
      queueReport({
        type: "run.failed",
        commandId: command.id,
        ...commandLeaseEventFields(command),
        sessionId: command.sessionId,
        runId: command.runId,
        agent: command.agent,
        error: detail,
        ...(reason && heartbeatFeatures.has("admission-retry") ? { admissionRejected: reason } : {}),
        exitCode: 1,
      }, "rejected start report capture failed", commandLogFields(sandboxId, command));
    };
    while (!stopping) {
      void refreshMcp();
      if (acknowledgeUpdatePause(stateDir)) {
        await delay(100, runtimeSignal);
        continue;
      }
      let completedEmptyLongPoll = false;
      let pollDeliveredCommands = false;
      let commandPollStartedAt = performance.now();
      let leaseObservationStartedAt = commandPollStartedAt;
      let pollHeartbeat: DaemonNodeHeartbeatSettings | undefined;
      const body = await withBackendReconnect(async () => {
        if (stopping) return { commands: [] };
        // Capability re-registration refreshes agent inventory independently
        // of the lightweight liveness heartbeat.
        const runtimeRefreshDue = runtimeRefreshCommands.size > 0 || Date.now() - lastRegisteredAt >= registrationRefreshIntervalMs;
        const canProbeNow = environment.canProbeWithoutBooting?.() ?? true;
        // Even an explicit refresh runs beside polling. An idle BoxLite guest
        // may boot for the probe; do not admit new runs until that boot ends.
        if (runtimeRefreshDue && (canProbeNow || supervisor.size === 0) && !backgroundRuntimeRefresh) {
          backgroundRuntimeRefresh = refreshIdleRuntimesInBackground().finally(() => { backgroundRuntimeRefresh = undefined; });
        }
        pollAbort = new AbortController();
        commandPollStartedAt = performance.now();
        pollInFlightSince = commandPollStartedAt;
        const response = await getJson(
          fetchFn,
          daemonCommandsUrl(backendUrl, sandboxId, {
            waitSeconds: recoveryPollPending ? 0 : commandPollWaitMs / 1000,
            admitRuns: storageDecision.admit && (canProbeNow || !backgroundRuntimeRefresh),
            leaseSeconds: commandLeaseSeconds,
            activeCommandLeases: activeCommandLeases(),
          }),
          token,
          AbortSignal.any([runtimeSignal, pollAbort.signal]),
          commandPollWaitMs + 2000,
        ).finally(() => { pollInFlightSince = undefined; pollAbort = undefined; });
        if (!response.ok) {
          const detail = `Command poll failed: ${response.status} ${await responseErrorDetail(response)}`;
          // A healthy registration route cannot renew execution ownership.
          // Retry transient poll failures directly so they retain outage grace.
          if (response.status >= 500 || response.status === 408 || response.status === 429) {
            throw new DaemonHttpError(detail, response.status, retryAfterMs(response.headers.get("Retry-After")));
          }
          // Gone is permanent: use the same clean shutdown as a deleted-node
          // registration instead of trying to bring the node back.
          if (response.status === 410 || response.status === 401) throw new DaemonHttpError(detail, response.status, retryAfterMs(response.headers.get("Retry-After")));
          // The backend may have restarted with fresh state or demoted this node;
          // re-register before treating the rejection as fatal.
          logger.warn("command poll rejected; re-registering", { sandboxId, error: detail });
          await register();
          lastRegisteredAt = Date.now();
          logger.info("daemon re-registered", { sandboxId });
          return { commands: [] };
        }
        const parsed = await response.json() as { commands?: DaemonNodeCommand[]; heartbeat?: DaemonNodeHeartbeatSettings; processingMs?: number };
        // Exclude the backend's long-poll wait from transport latency. Otherwise
        // a new one-second lease returned after a 25-second poll looks expired.
        const elapsed = performance.now() - commandPollStartedAt;
        const processingMs = typeof parsed.processingMs === "number" && Number.isFinite(parsed.processingMs)
          ? Math.max(0, Math.min(parsed.processingMs, elapsed)) : 0;
        leaseObservationStartedAt = commandPollStartedAt + processingMs;
        pollHeartbeat = parsed.heartbeat;
        renewExecutionLeases(pollHeartbeat, leaseObservationStartedAt);
        backendUnreachable = false;
        recoveryPollPending = false;
        pollDeliveredCommands = (parsed.commands ?? []).some(command => command.type !== 'run.cancel'
          || !terminalOutbox.quarantined(command.commandId, command.targetLeaseId));
        completedEmptyLongPoll = commandPollWaitMs > 0
          && !pollDeliveredCommands
          && performance.now() - commandPollStartedAt >= commandPollWaitMs;
        return parsed;
      }, logger, { sandboxId, what: "command poll" }, reconnectControl);
      if (stopping) break;
      for (const command of body.commands ?? []) {
        if (command.type === "runtime.refresh") {
          if (runtimeRefreshCommands.has(command.id) || runtimeRefreshCommands.size < 10) runtimeRefreshCommands.set(command.id, command.leaseId);
          continue;
        }
        if (command.type === "run.start") {
          protectStorage();
          if (!storageDecision.admit) continue;
          // A malformed or escaping workspaceSubpath throws out of resolveSubpath;
          // catch it here the same way the workspace.list/read branch does, so one
          // bad run.start command fails that command instead of crashing the daemon
          // and taking down every other run on this node.
          let sharedWorkspaceKey: string | undefined;
          try {
            assertRunWorkspaceScope(command, registeredComputerId);
            sharedWorkspaceKey = durableWorkspaceLayout(command.workspaceLayout)
              ? threadWorkspaces.resolveSubpath(command.sessionId, requiredWorkspaceSubpath(command)).hostPath
              : command.workspaceLayout === "thread"
                ? threadWorkspaces.resolve(command.sessionId).hostPath
                : workspacePath;
          } catch (error) {
            const detail = transportErrorDetail(error);
            logger.warn("command rejected for invalid workspace subpath", { ...commandLogFields(sandboxId, command), error: detail });
            postRejectedStart(command, detail);
            continue;
          }
          const preparation = environment.canProbeWithoutBooting?.() === false ? backgroundRuntimeRefresh : undefined;
          const admission = supervisor.accept(command, sharedWorkspaceKey, signal => {
            if (!options.environment && sandboxMode === "none") configureRelayMcp({home:homedir(),stateDir,sandboxId,backendUrl,runtimes:[command.agent],env:process.env});
            return executeCommand(backendUrl, sandboxId, token, command, fetchFn, logger,
              workspacePath, threadWorkspaces, environment, signal, echoAgentOutput, {
                outputBacklogBytes: positiveIntEnv('RELAY_DAEMON_OUTPUT_BACKLOG_BYTES'),
                outputDrainTimeoutMs: positiveIntEnv('RELAY_DAEMON_OUTPUT_DRAIN_TIMEOUT_MS'),
              });
          }, command.reportWorkspaceStatus ? (blockingSessionId, signal) => postJsonWithRetry(fetchFn,
            relayApiUrl(backendUrl, `/daemon-nodes/${encodeURIComponent(sandboxId)}/events`), {
              type: 'run.workspace', commandId: command.id, ...commandLeaseEventFields(command),
              sessionId: command.sessionId, runId: command.runId, agent: command.agent,
              waiting: blockingSessionId !== null, ...(blockingSessionId ? { blockingSessionId } : {}),
            } satisfies DaemonNodeEvent, token, signal) : undefined, preparation);
          if (admission === 'accepted') {
            logger.info("command received", commandLogFields(sandboxId, command));
            setHealth("busy", commandLogFields(sandboxId, command));
          } else if (admission === 'computer-capacity' || admission === 'runtime-capacity') {
            postRejectedStart(command, 'Daemon node has no available execution slot for this run.', admission);
          } else {
            logger.warn('command not started', { ...commandLogFields(sandboxId, command), reason: admission });
          }
          renewExecutionLeases(pollHeartbeat, leaseObservationStartedAt);
        } else if (command.type === "run.cancel") {
          admittedExecutions.add(command.commandId);
          const target = supervisor.has(command.commandId);
          // Keep the retained evidence and incident visible, but a redelivered
          // stop cannot make a permanently refused report retryable. Active
          // or uncertain processes must still receive cancellation handling.
          if (!target && !unconfirmedExecutions.has(command.commandId)
            && terminalOutbox.quarantined(command.commandId, command.targetLeaseId)) continue;
          logger.info("cancel command received", {
            sandboxId,
            commandId: command.commandId,
            sessionId: command.sessionId,
            runId: command.runId,
            agent: command.agent,
          });
          if (target) {
            supervisor.cancel(command.commandId, command.reason);
          } else if (unconfirmedExecutions.has(command.commandId) && !supervisor.isTerminal(command.commandId)) {
            observe(() => monitor?.cause('execution', true));
            logger.warn('Cancellation requires exit reconciliation for a journaled execution', { sandboxId, commandId: command.commandId });
          } else {
            // Nothing to stop: the start never reached this daemon (its poll
            // response was lost) or the daemon restarted since. The daemon is
            // the only party that knows the run is not executing, so it must
            // say so; otherwise the backend holds the run's slot forever.
            logger.info("cancel for a run this daemon is not executing; reporting it cancelled", {
              sandboxId,
              commandId: command.commandId,
              ...(command.targetLeaseId ? { leaseId: command.targetLeaseId } : {}),
              sessionId: command.sessionId,
              runId: command.runId,
            });
            // Retain the report before sending, and retry beside the poll loop.
            // A failed acknowledgement must not stop this computer taking work.
            queueReport({
              type: "run.cancelled",
              commandId: command.commandId,
              ...(command.targetLeaseId ? { leaseId: command.targetLeaseId } : {}),
              sessionId: command.sessionId,
              runId: command.runId,
              agent: command.agent,
              reason: command.reason || "Run was not executing on this computer.",
            }, "cancel acknowledgement capture failed", { sandboxId, commandId: command.commandId });
          }
        } else {
          const key = JSON.stringify([command.id, command.leaseId ?? null]);
          const lane = command.workspaceSubpath
            ? resolve(workspacePath, command.workspaceSubpath)
            : "workspaceLayout" in command && command.workspaceLayout === "thread"
              ? resolve(workspacePath, ".threads", command.sessionId ?? "") : workspacePath;
          commandTasks.submit(key, async () => {
            const event = workspaceReply(command, workspacePath, threadWorkspaces, projectLinks);
            await postJsonWithRetry(fetchFn, relayApiUrl(backendUrl, `/daemon-nodes/${encodeURIComponent(sandboxId)}/events`),
              event, token, runtimeSignal);
          }, { lane, lease: { commandId: command.id, leaseId: command.leaseId } });
        }
      }
      // A successful long-poll already supplied the idle wait, and a poll that
      // delivered commands is followed at once so the next command in a burst
      // (a second thread, a cancel, a refresh) is not held back a second.
      // Preserve an explicit caller delay and the default throttle for
      // rejected or failed polls.
      if (options.pollIntervalMs !== undefined || !(completedEmptyLongPoll || pollDeliveredCommands)) {
        await delay(pollIntervalMs, runtimeSignal);
      }
    }
    await shutdownPromise;
  } catch (error) {
    if (error instanceof DaemonHttpError && (error.status === 410 || error.status === 401)) {
      credentialsRejected = true;
      const reason = error.status === 410
        ? `node ${sandboxId} was deleted in the control panel.`
        : `the credential for node ${sandboxId} was rejected or reissued. Run setup again to reconnect this computer.`;
      logger.info("daemon credentials rejected; stopping", { sandboxId, reason });
      console.log(out.warn(`Relay daemon stopping: ${reason}`));
      shutdown("external", false);
      await shutdownPromise;
      return;
    }
    if ((error instanceof DaemonStoppedError || runtimeSignal.aborted || stopping) && shutdownPromise) {
      await shutdownPromise;
      return;
    }
    shutdown("external", false);
    await shutdownPromise;
    throw error;
  } finally {
    if (!shutdownController.signal.aborted) shutdownController.abort("Daemon loop ended.");
    clearInterval(watchdogTimer);
    clearInterval(storageTimer);
    await heartbeatTask;
    await outboxTask;
    await exitRecheckTask;
    await diagnosticsTask;
    await commandTasks.close();
    await backgroundRuntimeRefresh;
    cleanupShutdownListeners();
  }
}

export async function runRelayDaemonDoctor(options: DaemonRuntimeOptions = {}): Promise<DaemonDoctorReport> {
  const backendUrl = normalizeBaseUrl(options.backendUrl ?? process.env.RELAY_BACKEND_URL ?? process.env.RELAY_DAEMON_URL ?? "http://127.0.0.1:8790");
  const sandboxId = options.sandboxId ?? process.env.RELAY_SANDBOX_ID;
  const configuredUserId = options.userId ?? userIdFromEnv();
  const userId = configuredUserId ?? process.env.USER ?? "local";
  const workspacePath = firstNonBlank(options.workspacePath, process.env.RELAY_WORKSPACE, process.env.WORKSPACE) ?? process.cwd();
  const sandboxMode = resolveSandboxMode(options.sandbox ?? process.env.RELAY_SANDBOX_MODE);
  if (!options.environment) {
    assertHostAgentExecutionAllowed(
      sandboxMode,
      options.allowHostAgentExecution ?? process.env.RELAY_ALLOW_HOST_AGENT_EXECUTION === "1",
    );
  }
  const stateDir = resolve(options.stateDir ?? process.env.RELAY_DAEMON_STATE_DIR ?? join(homedir(), ".relay", "daemon-nodes", safeLogFileName(sandboxId ?? "doctor")));
  configureAgentProcessEnvironment(sandboxMode, workspacePath, options.agentHome);
  const logger = options.logger ?? createDaemonLogger({
    workspacePath,
    sandboxId: sandboxId ?? "doctor",
    logDir: options.logDir ?? join(stateDir, "logs"),
  });
  const fetchFn = options.fetchFn ?? createBackendFetch(recovery => {
    logger.warn('Backend transport recovery', { sandboxId, ...recovery });
  });
  const checks: DaemonDoctorCheck[] = [];
  const add = (name: string, ok: boolean, detail: string): void => {
    checks.push({ name, ok, detail });
    logger.info("daemon doctor check", { check: name, ok, detail, sandboxId });
  };
  if (existsSync(join(stateDir, 'transport-diagnostics.json'))) {
    try {
      const state = JSON.parse(readFileSync(join(stateDir, 'transport-diagnostics.json'), 'utf8'));
      add('transport', state.state === 'healthy' && state.causes?.length === 0 && Date.now() - state.observedAt < 10_000, `State: ${state.state}; pending reports: ${state.pending}; quarantined: ${state.quarantined}. Diagnostics: ${join(stateDir, 'transport-diagnostics.json')}`);
    } catch { add('transport', false, 'Transport diagnostics are unreadable; inspect the private state directory.'); }
  }
  if (sandboxMode === "none" && existsSync(join(stateDir,"mcp-status.json"))) {
    try {
      const status = JSON.parse(readFileSync(join(stateDir,"mcp-status.json"),"utf8")) as {status:string;code?:string;checkedAt?:number};
      const fresh = typeof status.checkedAt === "number" && Date.now() - status.checkedAt < 30*60_000;
      add("relay-mcp",fresh && status.status === "ready",!fresh ? "Standalone Relay MCP status is stale; start the daemon to reconcile." : status.status === "ready" ? "Standalone Relay MCP is configured." : status.code ?? "Relay MCP setup is retrying.");
    } catch { add("relay-mcp",false,"Relay MCP setup status is unreadable; restart the daemon to reconcile."); }
  }
  if (!sandboxId) {
    add("sandbox-id", false, "--sandbox-id or RELAY_SANDBOX_ID is required.");
    return { ok: false, checks };
  }
  let token = "";
  try {
    token = options.token?.trim() || process.env.RELAY_DAEMON_NODE_TOKEN?.trim() || process.env.RELAY_DAEMON_TOKEN?.trim()
      || readDaemonNodeToken(join(stateDir, "credentials"), userId) || "";
    if (!token) throw new Error("No saved node token. Enroll this computer before running doctor.");
    add("token", true, "daemon node token resolved.");
  } catch (error) {
    add("token", false, transportErrorDetail(error));
  }
  await checkBackendReachable(fetchFn, backendUrl, options.signal).then(
    () => add("backend", true, `${backendUrl} is reachable.`),
    (error: unknown) => add("backend", false, transportErrorDetail(error)),
  );
  try {
    checkWorkspace(workspacePath);
    add("workspace", true, `${workspacePath} exists and is writable.`);
  } catch (error) {
    add("workspace", false, transportErrorDetail(error));
  }
  const environment = options.environment ?? createExecutionEnvironment(sandboxMode, sandboxId, workspacePath, logger);
  const agentHealth = await discoverDaemonAgentHealth(environment, logger, sandboxId, options.signal);
  if (token) {
    try {
      const response = await fetchFn(relayApiUrl(backendUrl, `/daemon-nodes/${encodeURIComponent(sandboxId)}/auth-check`), {
        headers: { Authorization: `Bearer ${token}` }, signal: options.signal ?? AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`Node authentication failed (HTTP ${response.status}).`);
      const body = await response.json() as { sandboxId?: string; authenticated?: boolean };
      if (body.sandboxId !== sandboxId || body.authenticated !== true) throw new Error("Token does not identify this enrolled node.");
      add("authentication", true, "backend accepted the enrolled node token.");
    } catch (error) {
      add("authentication", false, transportErrorDetail(error));
    }
  }
  for (const agent of AGENT_NAMES) {
    const health = agentHealth[agent];
    add(`agent:${agent}`, health?.status === "ready", health?.detail ?? `${getAgent(agent).displayName} preflight did not report a result.`);
  }
  await environment.close().catch(() => undefined);
  return { ok: checks.every((check) => check.ok), checks };
}

function configureAgentProcessEnvironment(
  sandboxMode: DaemonSandboxMode,
  workspacePath: string,
  agentHome?: string,
): void {
  if (sandboxMode === "boxlite") {
    // Agent commands run inside the BoxLite guest, where the host workspace
    // is mounted at GUEST_WORKSPACE.
    process.env.RELAY_AGENT_WORKSPACE = GUEST_WORKSPACE;
    delete process.env.RELAY_RUN_AS_CURRENT_USER;
    delete process.env.RELAY_AGENT_HOME;
  } else {
    process.env.RELAY_AGENT_WORKSPACE = workspacePath;
    process.env.RELAY_RUN_AS_CURRENT_USER = "1";
    // Local nodes discover and run the user's existing host agents. An
    // explicit home remains available for service accounts and tests.
    process.env.RELAY_AGENT_HOME = agentHome ?? process.env.RELAY_AGENT_HOME ?? homedir();
  }
}

function firstNonBlank(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => value?.trim());
}

async function runStartupPreflight(input: {
  backendUrl: string;
  sandboxId: string;
  token: string;
  workspacePath: string;
  fetchFn: typeof fetch;
  logger: DaemonLogger;
  signal?: AbortSignal;
}): Promise<void> {
  if (!input.token.trim()) throw new Error("Daemon node token is required.");
  checkWorkspace(input.workspacePath);
  try {
    await checkBackendReachable(input.fetchFn, input.backendUrl, input.signal);
    input.logger.info("daemon preflight passed", { sandboxId: input.sandboxId, check: "backend" });
  } catch (error) {
    input.logger.warn("daemon backend preflight failed; registration will retry", {
      sandboxId: input.sandboxId,
      check: "backend",
      error: transportErrorDetail(error),
    });
  }
}

async function discoverDaemonAgentHealth(
  environment: DaemonExecutionEnvironment,
  logger: DaemonLogger,
  sandboxId: string,
  signal?: AbortSignal,
  agents: readonly AgentName[] = AGENT_NAMES,
  previous?: Partial<Record<AgentName, DaemonAgentHealth>>,
): Promise<Partial<Record<AgentName, DaemonAgentHealth>>> {
  const health: Partial<Record<AgentName, DaemonAgentHealth>> = {};
  for (const agent of agents) {
    const def = getAgent(agent);
    try {
      await environment.ensureAgentReady(agent, signal);
      health[agent] = {
        status: "ready",
        detail: `${def.displayName} preflight passed.`,
        adapter: "cli",
      };
    } catch (error) {
      health[agent] = {
        status: agentHealthStatusFor(error),
        detail: transportErrorDetail(error),
        adapter: "cli",
      };
    }
    // Periodic refreshes repeat the same answer; log only what changed.
    const current = health[agent]!;
    const before = previous?.[agent];
    if (before?.status === current.status && before.detail === current.detail) continue;
    if (current.status === "ready") logger.info("agent capability ready", { sandboxId, agent });
    // A runtime the user never installed is a fact about the computer, not a fault.
    else if (current.status === "unavailable") logger.info("agent not installed", { sandboxId, agent, detail: current.detail });
    else if (current.status === "unresponsive") logger.warn("agent not responding", { sandboxId, agent, error: current.detail });
    else logger.warn("agent capability failed", { sandboxId, agent, error: current.detail });
  }
  return health;
}

/** Which non-ready status a failed readiness check reports. */
export function agentHealthStatusFor(error: unknown): Exclude<DaemonAgentHealth["status"], "ready"> {
  if (error instanceof AgentNotInstalledError) return "unavailable";
  if (error instanceof AgentUnresponsiveError) return "unresponsive";
  return "failed";
}

function readyAgents(health: Partial<Record<AgentName, DaemonAgentHealth>>): AgentName[] {
  return AGENT_NAMES.filter((agent) => health[agent]?.status === "ready");
}

async function checkBackendReachable(fetchFn: typeof fetch, backendUrl: string, signal?: AbortSignal): Promise<void> {
  const url = `${backendUrl}/api`;
  const response = await fetchFn(url, { signal: requestSignal(signal) });
  if (!response.ok) {
    throw new DaemonHttpError(`GET ${url} failed: ${response.status} ${await responseErrorDetail(response)}`, response.status, retryAfterMs(response.headers.get("Retry-After")));
  }
}

function checkWorkspace(workspacePath: string): void {
  const stat = statSync(workspacePath);
  if (!stat.isDirectory()) throw new Error(`Workspace path is not a directory: ${workspacePath}`);
  accessSync(workspacePath, constants.R_OK | constants.W_OK);
}

/** One run's hold on the execution context that mounts its workspace. */
export interface WorkspaceExecution {
  ensureAgentReady(agent: AgentName, signal?: AbortSignal): Promise<void>;
  execStream: typeof localProcessExecStream;
  /** A run of this agent failed: its next run re-checks readiness. */
  forgetAgentReady?(agent: AgentName): void;
  release(): void;
}

export interface DaemonExecutionEnvironment {
  readonly sandboxMode: DaemonSandboxMode;
  /** Workspace-agnostic preflight, used by capability discovery. Probes
   * afresh each call so a runtime that stopped working is reported. */
  ensureAgentReady(agent: AgentName, signal?: AbortSignal): Promise<void>;
  /**
   * Whether discovery can run now without starting new execution capacity
   * (a BoxLite node borrows an already-booted guest). Absent means always:
   * a local node probes with plain host processes.
   */
  canProbeWithoutBooting?(): boolean;
  /** Workspace-agnostic exec, used by inventory and model discovery. */
  execStream: typeof localProcessExecStream;
  /** Hold the execution context for one run's workspace until release(). */
  acquireWorkspace(hostWorkspace: string, signal?: AbortSignal): Promise<WorkspaceExecution>;
  /**
   * After a restart, the ids of journaled runs this machine can prove are no
   * longer executing. Optional: without it every journaled run waits for a
   * person to report it gone.
   */
  proveExited?(records: ExecutionRecord[]): Promise<string[]>;
  close(): Promise<void>;
}

export function resolveSandboxMode(value: string | undefined): DaemonSandboxMode {
  const trimmed = value?.trim();
  if (!trimmed) return DEFAULT_DAEMON_SANDBOX_MODE;
  if (trimmed === "none") return "none";
  if (trimmed === "boxlite") return "boxlite";
  throw new Error(`Unknown sandbox mode ${JSON.stringify(trimmed)}. Use "boxlite" or "none".`);
}

export function assertHostAgentExecutionAllowed(
  mode: DaemonSandboxMode,
  allowed: boolean,
): void {
  if (mode === "none" && !allowed) {
    throw new Error(
      'Host agent execution is disabled. Use BoxLite, or pass --allow-host-agent-execution '
      + 'only after accepting that agent commands will run with your user account permissions.',
    );
  }
}

export function resolveDaemonStateDirectory(
  sandboxId: string,
  override = process.env.RELAY_DAEMON_STATE_DIR,
): string {
  const directory = resolve(
    override?.trim() || join(homedir(), ".relay", "daemon-nodes", safeLogFileName(sandboxId)),
  );
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  return directory;
}

function createExecutionEnvironment(
  mode: DaemonSandboxMode,
  sandboxId: string,
  workspacePath: string,
  logger: DaemonLogger,
  maxGuests = 1,
  maxConcurrentBoots = maxGuests,
): DaemonExecutionEnvironment {
  if (mode === "boxlite") {
    return createBoxliteEnvironment(sandboxId, workspacePath, logger, { maxGuests, maxConcurrentBoots });
  }
  return createLocalRuntime();
}

export interface BoxliteEnvironmentOptions {
  boxliteHome?: string;
  /** Shared by every guest; tests inject one. Production makes one per guest. */
  executionManager?: ExecutionManager;
  runtimeOwner?: BoxliteRuntimeOwner;
  /** Guests booted at once — one per concurrently running workspace. */
  maxGuests?: number;
  maxConcurrentBoots?: number;
}

export function createBoxliteEnvironment(
  sandboxId: string,
  workspacePath: string,
  logger: DaemonLogger,
  options: BoxliteEnvironmentOptions = {},
): DaemonExecutionEnvironment {
  const boxliteHome = resolveBoxliteHome(workspacePath, options.boxliteHome, sandboxId);
  const runtimeOwner = options.runtimeOwner ?? new BoxliteRuntimeOwner(boxliteHome);
  // Every guest mounts only its own workspace, so concurrent runs on
  // different threads each get a guest. All guests share the one native
  // runtime: a BoxLite home admits a single runtime per process.
  const pool = new GuestPool({
    capacity: options.maxGuests ?? 1,
    maxConcurrentBoots: options.maxConcurrentBoots,
    boxName: (slot) => boxNameForSandbox(sandboxId, slot),
    onUnconfirmed: (error) => logger.error("Guest retirement unconfirmed; slot remains fenced", { sandboxId, error: transportErrorDetail(error) }),
    createManager: () => options.executionManager ?? new BoxLiteExecutionManager(),
    start: ({ workspace, boxName, manager }) => startOrchestratorSession((text) => {
      logger.info("sandbox", { sandboxId, text: text.trimEnd() });
    }, {
      boxName,
      workspacePath: workspace,
      boxliteHome,
      runtimeOwner,
      executionManager: manager,
    }),
  });
  const workspaceExecution = (lease: GuestLease): WorkspaceExecution => ({
    ensureAgentReady: (agent, signal) => ensureSandboxAgentReady(agent, undefined, signal, lease.manager),
    execStream: (cmd, args = [], execOptions = {}) => lease.manager.execStream(cmd, args, execOptions),
    release: lease.release,
  });
  const withAnyGuest = async <T>(signal: AbortSignal | undefined, work: (lease: GuestLease) => Promise<T>): Promise<T> => {
    const lease = await pool.acquireAny(workspacePath, signal);
    try {
      return await work(lease);
    } finally {
      lease.release();
    }
  };
  return {
    sandboxMode: "boxlite",
    // Discovery probes afresh; runs keep the per-guest cache (workspaceExecution).
    ensureAgentReady: async (agent, signal) => {
      let lease: GuestLease;
      try {
        lease = await pool.acquireAny(workspacePath, signal);
      } catch (error) {
        // Every runtime on this computer is unreachable, not misconfigured:
        // say so, so the detail names the sandbox rather than the runtime.
        if (signal?.aborted) throw error;
        throw new Error(`The sandbox did not start: ${transportErrorDetail(error)}`);
      }
      try {
        await probeAgentReadiness(agent, signal, lease.manager);
      } finally {
        lease.release();
      }
    },
    canProbeWithoutBooting: () => pool.hasBootedGuest(),
    execStream: (cmd, args = [], execOptions = {}) =>
      withAnyGuest(execOptions.signal, (lease) => lease.manager.execStream(cmd, args, execOptions)),
    acquireWorkspace: async (hostWorkspace, signal) => workspaceExecution(await pool.acquire(hostWorkspace, signal)),
    // Agents only ever run inside this computer's guests, so once every guest
    // a previous daemon left behind is confirmed gone, so are its runs.
    async proveExited(records) {
      if (records.length === 0) return [];
      const runtime = await runtimeOwner.get() as Partial<GuestRuntime>;
      if (!runtime.listInfo || !runtime.remove) return [];
      const retired = await retireStaleGuests(runtime as GuestRuntime, boxNameForSandbox(sandboxId));
      return retired ? records.map((record) => record.id) : [];
    },
    async close() {
      try {
        await pool.close();
      } finally {
        await withExecutionDeadline(runtimeOwner.close(), 10_000, "BoxLite runtime shutdown");
      }
    },
  };
}

async function proveJournaledExits(
  environment: DaemonExecutionEnvironment,
  records: ExecutionRecord[],
  logger: DaemonLogger,
  sandboxId: string,
): Promise<ExecutionRecord[]> {
  if (records.length === 0 || !environment.proveExited) return [];
  try {
    const proven = new Set(await environment.proveExited(records));
    const exited = records.filter((record) => proven.has(record.id));
    for (const record of exited) {
      logger.info("Run admitted before the restart has provably stopped; reporting it cancelled", {
        sandboxId, commandId: record.id, runId: record.runId, sessionId: record.sessionId,
      });
    }
    return exited;
  } catch (error) {
    // No proof is the safe answer: those runs wait for a person instead.
    logger.warn("could not check runs admitted before the restart", {
      sandboxId, error: transportErrorDetail(error),
    });
    return [];
  }
}

function boxNameForSandbox(sandboxId: string, slot = 0): string {
  const base = `relay-${sandboxId.replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 48)}`;
  // Slot 0 keeps the historical name so an upgraded daemon reclaims its box.
  return slot === 0 ? base : `${base}-${slot}`;
}




/** Seconds from the environment as milliseconds; 0 is a valid "off". */
function nonNegativeSecondsEnv(name: string): number | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value * 1000) : undefined;
}

function positiveIntEnv(name: string): number | undefined {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

function booleanEnv(name: string): boolean | undefined {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) return undefined;
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  return undefined;
}

function boundedNumber(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.min(Math.max(value, minimum), maximum);
}

function daemonCommandsUrl(
  backendUrl: string,
  sandboxId: string,
  input: { waitSeconds: number; admitRuns?: boolean; leaseSeconds: number; activeCommandLeases: Array<{ commandId: string; leaseId?: string }> },
): string {
  const url = new URL(relayApiUrl(backendUrl, `/daemon-nodes/${encodeURIComponent(sandboxId)}/commands`));
  url.searchParams.set("waitSeconds", formatQueryNumber(input.waitSeconds));
  url.searchParams.set("leaseSeconds", formatQueryNumber(input.leaseSeconds));
  url.searchParams.set("leaseMode", "explicit");
  if (input.admitRuns === false) url.searchParams.set("admitRuns", "false");
  url.searchParams.set("limit", "10");
  for (const { commandId, leaseId } of input.activeCommandLeases) {
    if (leaseId) url.searchParams.append("activeCommandLease", `${commandId}:${leaseId}`);
  }
  return url.toString();
}

function formatQueryNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
}

export function createDaemonLogger(input: {
  workspacePath: string;
  sandboxId: string;
  logDir?: string;
} & DaemonLogWriterOptions): DaemonLogger {
  const logDir = input.logDir
    ?? join(homedir(), ".relay", "daemon-nodes", safeLogFileName(input.sandboxId), "logs");
  mkdirSync(logDir, { recursive: true, mode: 0o700 });
  chmodSync(logDir, 0o700);
  const logPath = join(logDir, `${safeLogFileName(input.sandboxId)}.log`);
  return new TextDaemonLogger(logDir, logPath, input);
}

class TextDaemonLogger implements DaemonLogger {
  private readonly renderers = new Map<string, StreamRenderer>();
  private readonly writer: DaemonLogWriter;

  constructor(
    private readonly logDir: string,
    public readonly logPath: string,
    options: DaemonLogWriterOptions = {},
  ) { this.writer = new DaemonLogWriter(logDir, logPath, options); }

  info(message: string, fields: DaemonLogFields = {}): void {
    this.write("info", message, fields);
  }

  warn(message: string, fields: DaemonLogFields = {}): void {
    this.write("warn", message, fields);
  }

  error(message: string, fields: DaemonLogFields = {}): void {
    this.write("error", message, fields);
  }

  output(fields: DaemonLogFields & { text: string; stream: "stdout" | "stderr" }): void {
    let text = fields.text;
    if (fields.agent && fields.stream === "stdout") {
      const key = fields.runId ?? fields.agent;
      let renderer = this.renderers.get(key);
      if (!renderer) {
        renderer = getAgent(fields.agent).createRenderer();
        this.renderers.set(key, renderer);
      }
      text = renderer.feed(text);
    }
    if (text) this.write("output", "agent output", { ...fields, text });
  }

  private write(level: string, message: string, fields: DaemonLogFields): void {
    if (fields.runId && ["run completed", "run cancelled", "run failed", "command failed before completion"].includes(message)) {
      this.renderers.delete(fields.runId);
    }
    const line = formatDaemonLog(new Date().toISOString(), level, message, fields);
    // Service managers capture stdout. Agent output already reaches it through
    // the runtime renderer (unless a supervisor explicitly disables that echo).
    if (level !== "output") process.stdout.write(line);
    this.writer.write(line, typeof fields.runId === "string" && fields.runId ? safeLogFileName(fields.runId) : undefined);
  }

  async flush(): Promise<void> {
    await this.writer.flush();
  }

  async close(): Promise<void> {
    await this.writer.close();
    this.renderers.clear();
  }
}

function safeLogFileName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "_") || "daemon-node";
}



/** Room for one round trip on a slow link; well inside launchd's 20 s exit timeout. */
const SHUTDOWN_REGISTRATION_TIMEOUT_MS = 2_500;
const DEFAULT_COMMAND_POLL_WAIT_MS = 25_000;
const MAX_COMMAND_POLL_WAIT_MS = 25_000;
const DEFAULT_LIVENESS_HEARTBEAT_MS = 6_000;
// A beat's own request timeout is its period, but never so short that a
// test-sized interval or a slow first byte fails every beat.
const MIN_HEARTBEAT_REQUEST_TIMEOUT_MS = 1_000;
const HEARTBEAT_JITTER_RATIO = 0.1;

/** ±10 % so daemons started together do not beat in lockstep. */
export function jittered(periodMs: number, random = Math.random): number {
  return Math.round(periodMs * (1 + HEARTBEAT_JITTER_RATIO * (2 * random() - 1)));
}
// A hung agent CLI must not wedge busy-time refreshes for the rest of the run.
const BUSY_RUNTIME_REFRESH_TIMEOUT_MS = 2 * 60_000;
const MAX_COMMAND_LEASE_SECONDS = 60 * 60;
const DEFAULT_COMMAND_LEASE_SECONDS = 90;
/** Longer than a typical backend deploy, and well inside the backend's 15-minute idle reaper. */
const DEFAULT_UNREACHABLE_GRACE_MS = 300_000;
/** Matches the backend's per-registration journal report bound. */
const JOURNAL_REPORT_LIMIT = 200;
/** How often a host run left over from a previous daemon is checked again for exit. */
const EXIT_RECHECK_INTERVAL_MS = 15_000;

interface ManagedDaemonEnrollment {
  sandboxId: string;
  token: string;
  userId?: string;
  sandboxMode?: DaemonNodeSandboxMode;
  heartbeat?: DaemonNodeHeartbeatSettings;
}

async function enrollManagedDaemon(
  fetchFn: typeof fetch,
  backendUrl: string,
  enrollmentToken: string,
  workspacePath: string,
  signal?: AbortSignal,
): Promise<ManagedDaemonEnrollment> {
  const url = relayApiUrl(backendUrl, "/daemon-node-enrollments");
  const response = await fetchFn(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Enrollment ${enrollmentToken}`,
    },
    body: JSON.stringify({ workspacePath }),
    signal: requestSignal(signal),
  });
  if (!response.ok) {
    throw new DaemonHttpError(`POST ${url} failed: ${response.status} ${await responseErrorDetail(response)}`, response.status, retryAfterMs(response.headers.get("Retry-After")));
  }
  const body = await response.json() as Partial<ManagedDaemonEnrollment>;
  if (!body.sandboxId || !body.token) throw new Error("Managed daemon enrollment response is incomplete.");
  return body as ManagedDaemonEnrollment;
}

function validHeartbeatSettings(
  value: DaemonNodeHeartbeatSettings | undefined,
): DaemonNodeHeartbeatSettings | undefined {
  if (!value || !Number.isFinite(value.intervalMs) || value.intervalMs <= 0) return undefined;
  if (!Number.isFinite(value.timeoutMs) || value.timeoutMs <= value.intervalMs) return undefined;
  return value;
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

export {
  activeBox,
  collectExecution,
  dockerImageId,
  ensureLocalDevboxOci,
  ensureSingleOrchestrator,
  execStream,
  hasHostKimiCodeAuth,
  importBoxLite,
  hostKimiCodeHomePath,
  hostAgentSkillsDir,
  prepareGuestAgentAuth,
  prepareGuestAgentSkills,
  prepareHostAgentSkills,
  prepareHostKimiCodeHome,
  prepareGuestWorkspace,
  setSessionBox,
  stopSessionBox,
  type BoxLiteModule,
  type DevboxOciOptions,
} from "./box.js";

export {
  BoxLiteExecutionManager,
  defaultExecutionManager,
  type CreateSandboxInput,
  type ExecutionManager,
  type ExecutionSandbox,
  type SandboxMount,
} from "./execution.js";

export {
  ensureAgentReady,
  resetAgentReadiness,
  resolveBoxliteHome,
  shutdownBoxliteRuntime,
  startOrchestratorSession,
  withOrchestratorSession,
  type ActiveOrchestratorSession,
  type OrchestratorSession,
  type OrchestratorSessionOptions,
} from "./sandbox-session.js";

export { discoverAgentInventory, parseInventoryOutput } from "./agent-inventory.js";
export { discoverAgentModels, parseAgentModels } from "./agent-models.js";

export {
  ThreadWorkspaceManager,
  type ThreadWorkspace,
} from "./thread-workspace.js";

function writePrivateDiagnostic(path: string, snapshot: unknown): void {
  const temporary = `${path}.tmp`;
  const descriptor = openSync(temporary, 'w', 0o600);
  try { writeFileSync(descriptor, JSON.stringify(snapshot)); fsyncSync(descriptor); } finally { closeSync(descriptor); }
  renameSync(temporary, path);
  syncDirectory(resolve(path, '..'));
}
