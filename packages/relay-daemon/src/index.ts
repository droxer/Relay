import { createHash } from "node:crypto";
import { err, out } from "./terminal-style.js";
import { legacyUserId, userIdFromEnv } from "./legacy-names.js";
import { loadManagedEnrollment, saveManagedEnrollment } from "./managed-enrollment.js";
import { createLocalRuntime, localProcessExecStream } from "./local-runtime.js";
import { AgentNotInstalledError, AgentUnresponsiveError } from "./agent-preflight.js";
import { responseErrorDetail } from "./http-error-detail.js";
export { localProcessExecStream } from "./local-runtime.js";
import { accessSync, chmodSync, constants, mkdirSync, statSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";

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
  AgentState,
  StreamExecResult,
  CodexCollaborationEvent,
  TokenUsage,
} from "relay-core";
import {
  startOrchestratorSession,
  ensureAgentReady as ensureSandboxAgentReady,
  probeAgentReadiness,
  resolveBoxliteHome,
  BoxliteRuntimeOwner,
} from "./sandbox-session.js";
import { GuestPool, type GuestLease } from "./guest-pool.js";
import { diffGeneratedFiles, snapshotGeneratedFiles } from "./generated-files.js";
import { consumeRoundResult, readRoundResult } from "./round-result.js";
import { syncProjectContext } from "./project-context.js";
import { consumeProjectSetup } from "./project-setup.js";
import { validateHandoffWorkspace } from "./handoff-validation.js";
import { agentWorkspaceSubpath, ensureAgentWorkspaceDir } from "./agent-workspace.js";
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
    console.error(error instanceof Error ? error.message : String(error));
    console.error(`Run: ${err.command("make devbox-oci")}`);
    process.exit(1);
  }
}
import {
  AGENT_NAMES,
  getAgent,
  runAgentNode,
  initialAgentState,
  mergeAgentState,
  ensureDaemonNodeToken,
  readDaemonNodeToken,
  ensureMachineId,
  GUEST_WORKSPACE,
  agentHomePath,
  agentCredentialEnv,
  customModelEndpointAgents,
  DAEMON_NODE_PROTOCOL_VERSION,
  relayApiUrl,
} from "relay-core";
import { DAEMON_ADVERTISED_CAPABILITIES } from "./capabilities.js";
import { workspaceCommandEvent } from "./workspace-read.js";
import { DEFAULT_ARTIFACTS_DIR, ThreadWorkspaceManager } from "./thread-workspace.js";
import { configuredProjectRoots, ProjectLinkError, ProjectLinkRegistry } from "./project-links.js";
import { OutputEventBuffer, type BufferedOutput } from "./output-event-buffer.js";
import { ExecutionWatchdog } from "./execution-watchdog.js";
import { ExecutionJournal } from "./execution-journal.js";
import { acknowledgeUpdatePause } from "./update-pause.js";
import { TerminalOutbox, persistTerminalEvent } from "./terminal-outbox.js";
import { watchExecutionExit } from "./execution-capture.js";
import { hostBootAt, retireStaleGuests, type GuestRuntime } from "./exit-proof.js";
import type { ExecutionRecord } from "./execution-journal.js";
import { WorkspaceRunGate } from "./workspace-run-gate.js";
import { materializeSkills } from "./agent-skills.js";
import { permissionPromptsApply, startPermissionBroker } from "./permission-broker.js";
import { permissionAdapterLaunch } from "./permission-adapters/index.js";

export type DaemonSandboxMode = DaemonNodeSandboxMode;
const DEFAULT_DAEMON_SANDBOX_MODE: DaemonSandboxMode = "boxlite";
/** Runs one daemon executes at once; override with RELAY_DAEMON_MAX_CONCURRENT_RUNS. */
export const DEFAULT_MAX_CONCURRENT_RUNS = 3;

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
  agentHome?: string;
  maxConcurrentRuns?: number;
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
  const rawFetch = options.fetchFn ?? fetch;
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
  // Set while execution endpoints fail transiently; cleared by an ownership
  // response or a 401/410 rejection. Registration alone cannot renew a run.
  let backendUnreachable = false;
  let heartbeatFeatures = new Set<DaemonNodeHeartbeatFeature>();
  let pollInFlightSince: number | undefined;
  let sendDrainingHeartbeat: (() => Promise<void>) | undefined;
  let sendStoppedHeartbeat: (() => Promise<void>) | undefined;
  const unreachableGraceMs = options.unreachableGraceMs
    ?? nonNegativeSecondsEnv("RELAY_DAEMON_UNREACHABLE_GRACE_SECONDS")
    ?? DEFAULT_UNREACHABLE_GRACE_MS;
  const executionWatchdog = new ExecutionWatchdog(undefined, {
    graceMs: unreachableGraceMs,
    shouldGrace: () => backendUnreachable,
    onGrace: (commandId) => logger.warn("Execution lease expired while the backend is unreachable; continuing for one grace period", {
      sandboxId, commandId, graceMs: unreachableGraceMs,
    }),
  });
  const terminalCommands = new Set<string>();
  const executionJournal = new ExecutionJournal(join(stateDir, "executions"));
  const terminalOutbox = new TerminalOutbox(join(stateDir, "terminal-events"), (id) => {
    executionJournal.confirmExit(id);
    terminalCommands.add(id);
    executionWatchdog.forget(id);
  });
  // A crash may land between durable terminal storage and journal removal.
  for (const record of terminalOutbox.pending()) {
    if (["run.completed", "run.failed", "run.cancelled"].includes(String(record.event.type))) executionJournal.confirmExit(String(record.event.commandId));
  }
  const unconfirmedExecutions = new Set(executionJournal.pending().map(record => record.id));
  // Retained executions the backend has not yet accounted for. Reported at
  // registration until acknowledged; unconfirmedExecutions keeps fencing them.
  const unreportedExecutions = new Set(unconfirmedExecutions);
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
  const logger = options.logger ?? createDaemonLogger({
    workspacePath,
    sandboxId,
    logDir: options.logDir ?? join(stateDir, "logs"),
  });
  const registrationRefreshIntervalMs = options.heartbeatIntervalMs ?? positiveIntEnv("RELAY_DAEMON_HEARTBEAT_MS") ?? positiveIntEnv("RELAY_DAEMON_NODE_HEARTBEAT_MS") ?? 5 * 60_000;
  const configuredLivenessHeartbeatIntervalMs = options.livenessHeartbeatIntervalMs
    ?? positiveIntEnv("RELAY_DAEMON_LIVENESS_HEARTBEAT_MS");
  const inventoryDiscoveryTimeoutMs = options.inventoryDiscoveryTimeoutMs ?? positiveIntEnv("RELAY_DAEMON_INVENTORY_TIMEOUT_MS") ?? 10_000;
  // Each concurrent run on a BoxLite node boots its own guest (one VM per
  // running thread), so this also bounds the node's guest memory.
  const maxConcurrentRuns = options.maxConcurrentRuns
    ?? positiveIntEnv("RELAY_DAEMON_MAX_CONCURRENT_RUNS")
    ?? DEFAULT_MAX_CONCURRENT_RUNS;
  const environment = options.environment
    ?? createExecutionEnvironment(sandboxMode, sandboxId, workspacePath, logger, maxConcurrentRuns);
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
  for (const execution of executionJournal.pending()) {
    if (provenExits.some((record) => record.id === execution.id)) continue;
    logger.warn("Execution exit unconfirmed after daemon restart; retained identity requires reconciliation", {
      sandboxId, commandId: execution.id, runId: execution.runId,
      sessionId: execution.sessionId, leaseId: execution.leaseId,
    });
  }
  setHealth("starting", { userId: effectiveUserId, workspacePath, backendUrl, sandboxMode });
  const activeRuns = new Map<string, { command: DaemonNodeRunCommand; controller: AbortController; promise: Promise<void> }>();
  // Runs whose stop could not be verified, each with the switch that lets it go.
  const unconfirmedExits = new Map<string, AbortController>();
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
  let agentModels = await discoverAgentModels(environment.execStream, readyAgents(agentHealth), options.signal, inventoryDiscoveryTimeoutMs, providerModelLists);
  const runtimeRefreshCommands = new Map<string, string>();
  let refreshedCommands: Array<{ commandId: string; leaseId: string }> = [];
  const buildRegistration = (includeUserId = Boolean(configuredUserId), status?: DaemonNodeRegistration["status"]): DaemonNodeRegistration => ({
    sandboxId,
    ...(includeUserId ? { userId: effectiveUserId } : {}),
    token,
    workspacePath,
    ...(workspaceId ? { workspaceId } : {}),
    sandboxMode,
    protocolVersion: DAEMON_NODE_PROTOCOL_VERSION,
    supportedAgents: readyAgents(agentHealth),
    executorCapabilities: Object.entries(agentHealth).map(([executorKind, health]) => ({
      executorKind: executorKind as AgentName,
      status: health.status,
      adapter: health.adapter ?? "cli",
      maxConcurrentRuns,
      ...(agentInventory[executorKind as AgentName] ? { inventory: agentInventory[executorKind as AgentName] } : {}),
    })),
    runtimeRefreshCommands: refreshedCommands,
    ...(unreportedExecutions.size > 0 ? { journaledCommandIds: [...unreportedExecutions].slice(0, JOURNAL_REPORT_LIMIT) } : {}),
    capabilities: [...DAEMON_ADVERTISED_CAPABILITIES],
    agentHealth,
    ...(Object.keys(agentInventory).length > 0 ? { agentInventory } : {}),
    customModelEndpoints: customModelEndpointAgents(),
    agentModels,
    maxConcurrentRuns,
    status: status ?? (activeRuns.size > 0 ? "busy" : "ready"),
  });
  const register = async (): Promise<DaemonNodeHeartbeatSettings | undefined> => {
    const url = relayApiUrl(backendUrl, "/daemon-node-registrations");
    const response = await postJsonResponse<DaemonNodeRegistrationResponse>(
      fetchFn, url, buildRegistration(), undefined, runtimeSignal,
    );
    for (const id of response.acknowledgedJournalIds ?? []) {
      if (!unreportedExecutions.delete(id)) continue;
      // The backend now holds the run as interrupted (or already settled), so
      // the record has served its purpose. The fence stays for this process.
      executionJournal.confirmExit(id);
    }
    if (Array.isArray(response.projectLinks)) {
      for (const rejected of projectLinks.replaceAll(response.projectLinks)) {
        logger.warn("linked project directory refused", { sandboxId, ...rejected });
      }
    }
    return validHeartbeatSettings(response.heartbeat);
  };
  if (options.preflight !== false) {
    await runStartupPreflight({ backendUrl, sandboxId, token, workspacePath, fetchFn, logger, signal: runtimeSignal });
  }
  const shutdown = (signal: NodeJS.Signals | "external", exitProcess: boolean): void => {
    shutdownPromise ??= (async () => {
      stopping = true;
      if (!shutdownController.signal.aborted) shutdownController.abort(`Daemon received ${signal}.`);
      setHealth("stopping", { signal });
      logger.info("daemon stopping", { sandboxId, signal });
      // Tell the backend first that no more work will be taken, so nothing is
      // dispatched into the drain and lost; the runs below keep their leases.
      if (!credentialsRejected && heartbeatFeatures.has("state")) {
        await sendDrainingHeartbeat?.();
      }
      for (const active of activeRuns.values()) active.controller.abort(`Daemon received ${signal}.`);
      await Promise.race([
        Promise.allSettled([...activeRuns.values()].map((active) => active.promise)),
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
          logger.warn("daemon stopped notice failed", { sandboxId, error: error instanceof Error ? error.message : String(error) });
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
  const handleExternalAbort = (): void => shutdown("external", false);
  const cleanupShutdownListeners = (): void => {
    process.off("SIGINT", handleSigint);
    process.off("SIGTERM", handleSigterm);
    options.signal?.removeEventListener("abort", handleExternalAbort);
  };
  process.once("SIGINT", handleSigint);
  process.once("SIGTERM", handleSigterm);
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
  const watchdogTimer = setInterval(() => executionWatchdog.tick(), 1000);
  watchdogTimer.unref();
  let heartbeatTask: Promise<void> | undefined;
  let outboxTask: Promise<void> | undefined;
  try {
    const reconnectControl = {
      signal: runtimeSignal,
      shouldStop: () => stopping,
      onTransientFailure: () => { backendUnreachable = true; },
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
    let lastRegisteredAt = Date.now();
    for (const record of provenExits) {
      // Persisted to the outbox before sending, so delivery survives another
      // restart; the outbox clears the journal record once it holds the event.
      void postJsonWithRetry(fetchFn, relayApiUrl(backendUrl, `/daemon-nodes/${encodeURIComponent(sandboxId)}/events`), {
        type: "run.cancelled",
        commandId: record.id,
        ...(record.leaseId ? { leaseId: record.leaseId } : {}),
        sessionId: record.sessionId,
        runId: record.runId,
        agent: record.agent as AgentName,
        reason: "The computer restarted, and this run's process had already stopped.",
      } satisfies DaemonNodeEvent, token, runtimeSignal).catch((error: unknown) => {
        logger.warn("proven-exit report failed; the outbox will retry", {
          sandboxId, commandId: record.id, error: error instanceof Error ? error.message : String(error),
        });
      });
    }
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
        unconfirmedExits.get(commandId)?.abort("Reported gone by an operator.");
      }
      if (!settings?.commandLeases) return;
      const observedAt = Date.parse(settings.observedAt ?? "");
      for (const lease of settings.commandLeases) {
        if (activeRuns.get(lease.commandId)?.command.leaseId !== lease.leaseId) continue;
        const duration = Date.parse(lease.leaseExpiresAt) - observedAt - (performance.now() - sentAt);
        if (Number.isFinite(duration)) executionWatchdog.renew(lease.commandId, duration, observedAt);
      }
    };
    const sendHeartbeat = async (state?: DaemonNodeHeartbeatState, signal: AbortSignal = runtimeSignal): Promise<void> => {
      const sentAt = performance.now();
      const renewing = [...activeRuns.values()].filter(({ command }) => !terminalCommands.has(command.id));
      const url = relayApiUrl(backendUrl, `/daemon-nodes/${encodeURIComponent(sandboxId)}/heartbeat`);
      try {
        const response = await postJsonResponse<DaemonNodeHeartbeatResponse>(
          fetchFn,
          url,
          {
            leaseSeconds: commandLeaseSeconds,
            activeCommandLeases: renewing.map(({ command }) => ({
              commandId: command.id,
              ...(command.leaseId ? { leaseId: command.leaseId } : {}),
            })),
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
        logger.warn(`daemon ${state} heartbeat failed`, { sandboxId, error: error instanceof Error ? error.message : String(error) });
        if (state === "stopped") throw error;
      });
    };
    sendDrainingHeartbeat = shutdownBeat("draining");
    sendStoppedHeartbeat = shutdownBeat("stopped");
    // A busy computer still re-checks the runtimes no run is using, in the
    // background so the command poll (and any cancel it carries) is not held
    // up. Runtimes in use keep their last report: probing them would touch
    // the credentials the running agent is using. A BoxLite node probes
    // inside a guest that is already up and skips the round while none is.
    let busyRuntimeRefresh: Promise<void> | undefined;
    const refreshIdleRuntimesWhileBusy = async (): Promise<void> => {
      const inUse = new Set([...activeRuns.values()].map(({ command }) => command.agent));
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
        const models = await discoverAgentModels(environment.execStream, readyAgents(health), signal, inventoryDiscoveryTimeoutMs, providerModelLists);
        if (signal.aborted || stopping) return;
        agentHealth = { ...agentHealth, ...health };
        agentInventory = keepInUse(inventory, agentInventory);
        agentModels = keepInUse(models, agentModels);
        refreshedCommands = commands.map(([commandId, leaseId]) => ({ commandId, leaseId }));
        updateHeartbeatSettings(await register());
      } catch (error) {
        logger.warn("busy runtime refresh failed; it will retry", {
          sandboxId, error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        refreshedCommands = [];
        // A failed attempt waits out the interval instead of retrying every
        // poll; an unacknowledged refresh request is redelivered once its
        // lease lapses.
        for (const [commandId] of commands) runtimeRefreshCommands.delete(commandId);
        lastRegisteredAt = Date.now();
      }
    };
    outboxTask = (async () => {
      while (!runtimeSignal.aborted) {
        await terminalOutbox.replay(rawFetch, relayApiUrl(backendUrl, `/daemon-nodes/${encodeURIComponent(sandboxId)}/events`), token, runtimeSignal);
        await delay(5000, runtimeSignal);
      }
    })().catch((error: unknown) => {
      if (!runtimeSignal.aborted) logger.error("terminal replay stopped", { error: String(error) });
    });
    const heartbeatPeriodMs = (): number => Math.min(livenessHeartbeatIntervalMs, commandLeaseSeconds * 1000 / 3);
    const heartbeatRequestTimeoutMs = (): number => Math.max(MIN_HEARTBEAT_REQUEST_TIMEOUT_MS, heartbeatPeriodMs());
    heartbeatTask = (async () => {
      // Fixed rate with jitter, one attempt per tick. A failed beat is not
      // retried inside the tick: the next tick is the retry, so a retry never
      // waits longer than a beat, and a fleet started together drifts apart.
      let nextBeatAt = performance.now() + heartbeatPeriodMs();
      while (!stopping && !runtimeSignal.aborted) {
        await delay(Math.max(0, nextBeatAt - performance.now()), runtimeSignal);
        nextBeatAt = performance.now() + jittered(heartbeatPeriodMs());
        if (stopping || runtimeSignal.aborted) return;
        if (pollRenewsLiveness()) continue;
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
          logger.warn("liveness heartbeat failed; next beat retries", {
            sandboxId, error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    })().catch((error: unknown) => {
      if (stopping || runtimeSignal.aborted || error instanceof DaemonStoppedError) return;
      if (error instanceof DaemonHttpError && (error.status === 401 || error.status === 410)) {
        credentialsRejected = true;
        logger.info("daemon credentials rejected; run setup again", { sandboxId, status: error.status });
        shutdown("external", false);
        return;
      }
      logger.error("liveness heartbeat stopped", {
        sandboxId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
    const cancellationTerminalEventSignal = (): AbortSignal | undefined =>
      stopping ? AbortSignal.timeout(SHUTDOWN_TERMINAL_EVENT_TIMEOUT_MS) : undefined;
    while (!stopping) {
      if (acknowledgeUpdatePause(stateDir)) {
        await delay(100, runtimeSignal);
        continue;
      }
      let completedEmptyLongPoll = false;
      let commandPollStartedAt = performance.now();
      let leaseObservationStartedAt = commandPollStartedAt;
      let pollHeartbeat: DaemonNodeHeartbeatSettings | undefined;
      const body = await withBackendReconnect(async () => {
        if (stopping) return { commands: [] };
        // Capability re-registration refreshes agent inventory independently
        // of the lightweight liveness heartbeat.
        const runtimeRefreshDue = runtimeRefreshCommands.size > 0 || Date.now() - lastRegisteredAt >= registrationRefreshIntervalMs;
        if (runtimeRefreshDue && activeRuns.size > 0 && !busyRuntimeRefresh && (environment.canProbeWithoutBooting?.() ?? true)) {
          busyRuntimeRefresh = refreshIdleRuntimesWhileBusy().finally(() => { busyRuntimeRefresh = undefined; });
        }
        if (activeRuns.size === 0 && !busyRuntimeRefresh && runtimeRefreshDue) {
          agentHealth = await discoverDaemonAgentHealth(environment, logger, sandboxId, runtimeSignal, AGENT_NAMES, agentHealth);
          agentInventory = await discoverAgentInventory(environment.execStream, runtimeSignal, inventoryDiscoveryTimeoutMs);
          agentModels = await discoverAgentModels(environment.execStream, readyAgents(agentHealth), runtimeSignal, inventoryDiscoveryTimeoutMs, providerModelLists);
          refreshedCommands = [...runtimeRefreshCommands].slice(0, 50).map(([commandId, leaseId]) => ({ commandId, leaseId }));
          updateHeartbeatSettings(await register());
          for (const { commandId } of refreshedCommands) runtimeRefreshCommands.delete(commandId);
          refreshedCommands = [];
          lastRegisteredAt = Date.now();
        }
        commandPollStartedAt = performance.now();
        pollInFlightSince = commandPollStartedAt;
        const response = await getJson(
          fetchFn,
          daemonCommandsUrl(backendUrl, sandboxId, {
            waitSeconds: commandPollWaitMs / 1000,
            leaseSeconds: commandLeaseSeconds,
            activeCommandLeases: [...activeRuns.values()].filter(({ command }) => !terminalCommands.has(command.id)).map(({ command }) => ({
              commandId: command.id,
              leaseId: command.leaseId,
            })),
          }),
          token,
          runtimeSignal,
        ).finally(() => { pollInFlightSince = undefined; });
        if (!response.ok) {
          const detail = `Command poll failed: ${response.status} ${await responseErrorDetail(response)}`;
          // A healthy registration route cannot renew execution ownership.
          // Retry transient poll failures directly so they retain outage grace.
          if (response.status >= 500 || response.status === 408 || response.status === 429) {
            throw new DaemonHttpError(detail, response.status);
          }
          // Gone is permanent: use the same clean shutdown as a deleted-node
          // registration instead of trying to bring the node back.
          if (response.status === 410 || response.status === 401) throw new DaemonHttpError(detail, response.status);
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
        completedEmptyLongPoll = commandPollWaitMs > 0
          && (parsed.commands?.length ?? 0) === 0
          && performance.now() - commandPollStartedAt >= commandPollWaitMs;
        return parsed;
      }, logger, { sandboxId, what: "command poll" }, reconnectControl);
      if (stopping) break;
      for (const command of body.commands ?? []) {
        if (command.type === "runtime.refresh") {
          runtimeRefreshCommands.set(command.id, command.leaseId);
          continue;
        }
        if (command.type === "run.start") {
          const active = activeRuns.get(command.id);
          if (active) {
            refreshCommandLease(active.command, command);
            logger.warn("duplicate command ignored", {
              ...commandLogFields(sandboxId, command),
              leaseId: command.leaseId,
              attempt: command.attempt,
            });
            continue;
          }
          if (unconfirmedExecutions.has(command.id)) {
            logger.warn("Unconfirmed execution will not be restarted", commandLogFields(sandboxId, command));
            continue;
          }
          if (!canStartCommand(activeRuns, maxConcurrentRuns, terminalCommands)) {
            const detail = "Daemon node has no available execution slot for this run.";
            logger.warn("command rejected while daemon busy", { ...commandLogFields(sandboxId, command), error: detail });
            await postJsonWithRetry(fetchFn, relayApiUrl(backendUrl, `/daemon-nodes/${encodeURIComponent(sandboxId)}/events`), {
              type: "run.failed",
              commandId: command.id,
              ...commandLeaseEventFields(command),
              sessionId: command.sessionId,
              runId: command.runId,
              agent: command.agent,
              error: detail,
              exitCode: 1,
            } satisfies DaemonNodeEvent, token, runtimeSignal);
            continue;
          }
          // A malformed or escaping workspaceSubpath throws out of resolveSubpath;
          // catch it here the same way the workspace.list/read branch does, so one
          // bad run.start command fails that command instead of crashing the daemon
          // and taking down every other run on this node.
          let sharedWorkspaceKey: string | undefined;
          try {
            sharedWorkspaceKey = durableWorkspaceLayout(command.workspaceLayout)
              ? threadWorkspaces.resolveSubpath(command.sessionId, requiredWorkspaceSubpath(command)).hostPath
              : command.workspaceLayout === "thread"
                ? threadWorkspaces.resolve(command.sessionId).hostPath
                : workspacePath;
          } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            logger.warn("command rejected for invalid workspace subpath", { ...commandLogFields(sandboxId, command), error: detail });
            await postJsonWithRetry(fetchFn, relayApiUrl(backendUrl, `/daemon-nodes/${encodeURIComponent(sandboxId)}/events`), {
              type: "run.failed",
              commandId: command.id,
              ...commandLeaseEventFields(command),
              sessionId: command.sessionId,
              runId: command.runId,
              agent: command.agent,
              error: detail,
              exitCode: 1,
            } satisfies DaemonNodeEvent, token, runtimeSignal);
            continue;
          }
          logger.info("command received", commandLogFields(sandboxId, command));
          setHealth("busy", commandLogFields(sandboxId, command));
          executionJournal.record(command);
          const controller = new AbortController();
          if (command.leaseId) executionWatchdog.track(command.id, commandLeaseSeconds * 1000,
            () => controller.abort("Execution lease expired; stopping until ownership can be confirmed."));
          const release = new AbortController();
          watchExecutionExit(controller.signal, {
            release: release.signal,
            onSpawn: (processGroup, spawnedAt) => {
              try {
                executionJournal.attach(command.id, { processGroup, spawnedAt, bootAt: hostBootAt() });
              } catch (error) {
                logger.warn("could not record the run's process group", {
                  ...commandLogFields(sandboxId, command),
                  error: error instanceof Error ? error.message : String(error),
                });
              }
            },
            onExitUnconfirmed: () => {
              unconfirmedExits.set(command.id, release);
              logger.warn("Stopped run's exit cannot be verified; reporting it and keeping the run reserved", commandLogFields(sandboxId, command));
              void postJsonWithRetry(fetchFn, relayApiUrl(backendUrl, `/daemon-nodes/${encodeURIComponent(sandboxId)}/events`), {
                type: "run.exit_unconfirmed",
                commandId: command.id,
                ...commandLeaseEventFields(command),
                sessionId: command.sessionId,
                runId: command.runId,
                agent: command.agent,
              } satisfies DaemonNodeEvent, token, runtimeSignal).catch((error: unknown) => {
                logger.warn("exit-unconfirmed report failed", {
                  ...commandLogFields(sandboxId, command),
                  error: error instanceof Error ? error.message : String(error),
                });
              });
            },
          });
          const promise = Promise.resolve().then(() =>
            workspaceRunGate.run(sharedWorkspaceKey, controller.signal, () => executeCommand(
              backendUrl,
              sandboxId,
              token,
              command,
              fetchFn,
              logger,
              workspacePath,
              threadWorkspaces,
              environment,
              controller.signal,
              echoAgentOutput,
            ), command.reportWorkspaceStatus ? {
              sessionId: command.sessionId,
              onWaiting: async (blockingSessionId) => {
                await postJsonWithRetry(fetchFn, relayApiUrl(backendUrl, `/daemon-nodes/${encodeURIComponent(sandboxId)}/events`), {
                  type: "run.workspace",
                  commandId: command.id,
                  ...commandLeaseEventFields(command),
                  sessionId: command.sessionId,
                  runId: command.runId,
                  agent: command.agent,
                  waiting: blockingSessionId !== null,
                  ...(blockingSessionId ? { blockingSessionId } : {}),
                } satisfies DaemonNodeEvent, token, controller.signal);
              },
            } : undefined),
          ).then(async (event) => {
            // The workspace gate has released and the process has exited. The
            // outbox marks this command terminal before HTTP delivery begins,
            // so pending acknowledgements consume neither execution nor workspace slots.
            await postJsonWithRetry(fetchFn, relayApiUrl(backendUrl, `/daemon-nodes/${encodeURIComponent(sandboxId)}/events`),
              event, token, controller.signal.aborted ? cancellationTerminalEventSignal() : controller.signal);
          }).catch(async (error: unknown) => {
            const message = error instanceof Error ? error.message : String(error);
            logger.error("command failed before completion", { ...commandLogFields(sandboxId, command), error: message });
            const eventUrl = relayApiUrl(backendUrl, `/daemon-nodes/${encodeURIComponent(sandboxId)}/events`);
            const event = controller.signal.aborted
              ? {
                  type: "run.cancelled",
                  commandId: command.id,
                  ...commandLeaseEventFields(command),
                  sessionId: command.sessionId,
                  runId: command.runId,
                  agent: command.agent,
                  reason: typeof controller.signal.reason === "string" ? controller.signal.reason : "Daemon run cancelled.",
                } satisfies DaemonNodeEvent
              : {
                  type: "run.failed",
                  commandId: command.id,
                  ...commandLeaseEventFields(command),
                  sessionId: command.sessionId,
                  runId: command.runId,
                  agent: command.agent,
                  error: message,
                } satisfies DaemonNodeEvent;
            await postJsonWithRetry(
              fetchFn,
              eventUrl,
              event,
              token,
              controller.signal.aborted ? cancellationTerminalEventSignal() : controller.signal,
            ).catch((postError: unknown) => {
              logger.error("terminal event post failed", {
                ...commandLogFields(sandboxId, command),
                error: postError instanceof Error ? postError.message : String(postError),
              });
            });
          }).finally(() => {
            unconfirmedExits.delete(command.id);
            activeRuns.delete(command.id);
            terminalCommands.delete(command.id);
            executionWatchdog.forget(command.id);
            if (!stopping) setHealth("polling");
          });
          activeRuns.set(command.id, { command, controller, promise });
          renewExecutionLeases(pollHeartbeat, leaseObservationStartedAt);
        } else if (command.type === "run.cancel") {
          logger.info("cancel command received", {
            sandboxId,
            commandId: command.commandId,
            sessionId: command.sessionId,
            runId: command.runId,
            agent: command.agent,
          });
          const target = activeRuns.get(command.commandId);
          if (target) {
            target.controller.abort(command.reason);
          } else {
            // Nothing to stop: the start never reached this daemon (its poll
            // response was lost) or the daemon restarted since. The daemon is
            // the only party that knows the run is not executing, so it must
            // say so; otherwise the backend holds the run's slot forever.
            logger.warn("cancel for a run this daemon is not executing; reporting it cancelled", {
              sandboxId,
              commandId: command.commandId,
              sessionId: command.sessionId,
              runId: command.runId,
            });
            await postJsonWithRetry(fetchFn, relayApiUrl(backendUrl, `/daemon-nodes/${encodeURIComponent(sandboxId)}/events`), {
              type: "run.cancelled",
              commandId: command.commandId,
              sessionId: command.sessionId,
              runId: command.runId,
              agent: command.agent,
              reason: command.reason || "Run was not executing on this computer.",
            } satisfies DaemonNodeEvent, token, runtimeSignal).catch((error: unknown) => {
              logger.error("cancel acknowledgement post failed", {
                sandboxId,
                commandId: command.commandId,
                error: error instanceof Error ? error.message : String(error),
              });
            });
          }
        } else if (command.type === "workspace.delete") {
          try {
            if (command.workspaceLayout !== "project" || command.path !== "") {
              throw new Error("Only a complete project workspace can be deleted.");
            }
            threadWorkspaces.deleteProject(command.sessionId, command.workspaceSubpath);
            await postJsonWithRetry(fetchFn, relayApiUrl(backendUrl, `/daemon-nodes/${encodeURIComponent(sandboxId)}/events`), {
              type: "workspace.deleted", commandId: command.id,
              ...(command.leaseId ? { leaseId: command.leaseId } : {}), path: "",
            }, token, runtimeSignal);
          } catch (error) {
            // Unacknowledged leases are retried. Cleanup must survive I/O
            // failures and lost acknowledgements, and is idempotent.
            logger.error("project workspace cleanup failed; will retry", {
              sandboxId, commandId: command.id,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        } else if (command.type === "workspace.link") {
          let event: DaemonNodeEvent;
          try {
            const hostPath = command.dryRun
              ? projectLinks.validate(command.hostPath)
              : projectLinks.link(command.workspaceSubpath, command.hostPath);
            event = {
              type: "workspace.linked", commandId: command.id,
              ...(command.leaseId ? { leaseId: command.leaseId } : {}), path: "", hostPath,
            };
          } catch (error) {
            event = {
              type: "workspace.error",
              commandId: command.id,
              ...(command.leaseId ? { leaseId: command.leaseId } : {}),
              path: "",
              code: error instanceof ProjectLinkError ? error.code : "io-error",
              message: error instanceof Error ? error.message : String(error),
            };
          }
          await postJsonWithRetry(fetchFn, relayApiUrl(backendUrl, `/daemon-nodes/${encodeURIComponent(sandboxId)}/events`), event, token, runtimeSignal).catch((error: unknown) => {
            logger.error("project link event post failed", { sandboxId, commandId: command.id, error: error instanceof Error ? error.message : String(error) });
          });
        } else if (command.type === "workspace.list" || command.type === "workspace.read") {
          // Thread ids and durable workspaceSubpaths are validated before the workspace-read helpers
          // run, so an escaping path throws here rather than inside workspaceCommandEvent —
          // catch it the same way, as a workspace.error event, instead of letting it
          // fall out of the poll loop and take the whole daemon down.
          let event: DaemonNodeEvent;
          try {
            if (command.workspaceLayout === "thread" && !command.sessionId) {
              throw new Error("Thread workspace command is missing sessionId.");
            }
            const commandWorkspacePath = command.workspaceLayout === "thread"
              ? threadWorkspaces.resolve(command.sessionId!).hostPath
              : durableWorkspaceLayout(command.workspaceLayout) && command.sessionId
                ? threadWorkspaces.resolveSubpath(command.sessionId, requiredWorkspaceSubpath(command)).hostPath
                : workspacePath;
            event = workspaceCommandEvent(commandWorkspacePath, command);
          } catch (error) {
            event = {
              type: "workspace.error",
              commandId: command.id,
              ...(command.leaseId ? { leaseId: command.leaseId } : {}),
              path: command.path,
              code: "invalid-path",
              message: error instanceof Error ? error.message : String(error),
            };
          }
          await postJsonWithRetry(fetchFn, relayApiUrl(backendUrl, `/daemon-nodes/${encodeURIComponent(sandboxId)}/events`), event, token, runtimeSignal).catch((error: unknown) => {
            logger.error("workspace event post failed", { sandboxId, commandId: command.id, error: error instanceof Error ? error.message : String(error) });
          });
        }
      }
      // A successful long-poll already supplied the idle wait. Preserve an
      // explicit caller delay and the default throttle for rejected polls.
      if (!completedEmptyLongPoll || options.pollIntervalMs !== undefined) {
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
    throw error;
  } finally {
    if (!shutdownController.signal.aborted) shutdownController.abort("Daemon loop ended.");
    clearInterval(watchdogTimer);
    await heartbeatTask;
    await outboxTask;
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
  const fetchFn = options.fetchFn ?? fetch;
  const checks: DaemonDoctorCheck[] = [];
  const add = (name: string, ok: boolean, detail: string): void => {
    checks.push({ name, ok, detail });
    logger.info("daemon doctor check", { check: name, ok, detail, sandboxId });
  };
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
    add("token", false, error instanceof Error ? error.message : String(error));
  }
  await checkBackendReachable(fetchFn, backendUrl, options.signal).then(
    () => add("backend", true, `${backendUrl} is reachable.`),
    (error: unknown) => add("backend", false, error instanceof Error ? error.message : String(error)),
  );
  try {
    checkWorkspace(workspacePath);
    add("workspace", true, `${workspacePath} exists and is writable.`);
  } catch (error) {
    add("workspace", false, error instanceof Error ? error.message : String(error));
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
      add("authentication", false, error instanceof Error ? error.message : String(error));
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
      error: error instanceof Error ? error.message : String(error),
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
        detail: error instanceof Error ? error.message : String(error),
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
    throw new DaemonHttpError(`GET ${url} failed: ${response.status} ${await responseErrorDetail(response)}`, response.status);
  }
}

function checkWorkspace(workspacePath: string): void {
  const stat = statSync(workspacePath);
  if (!stat.isDirectory()) throw new Error(`Workspace path is not a directory: ${workspacePath}`);
  accessSync(workspacePath, constants.R_OK | constants.W_OK);
}

/** "project" and "task" both resolve to a shared durable subpath below the node root. */
function durableWorkspaceLayout(layout: string | undefined): boolean {
  return layout === "project" || layout === "task";
}

function requiredWorkspaceSubpath(command: { workspaceSubpath?: string }): string {
  if (!command.workspaceSubpath) {
    throw new Error("Durable workspace command is missing workspaceSubpath.");
  }
  return command.workspaceSubpath;
}

async function executeCommand(
  backendUrl: string,
  sandboxId: string,
  token: string,
  command: DaemonNodeRunCommand,
  fetchFn: typeof fetch,
  logger: DaemonLogger,
  nodeWorkspacePath: string,
  threadWorkspaces: ThreadWorkspaceManager,
  environment: DaemonExecutionEnvironment,
  signal?: AbortSignal,
  echoAgentOutput = true,
): Promise<DaemonNodeEvent> {
  const eventUrl = relayApiUrl(backendUrl, `/daemon-nodes/${encodeURIComponent(sandboxId)}/events`);
  const state = { ...(command.state ?? initialAgentState(command.taskGoal)), round_result_run_id: command.runId };
  logger.info("run starting", commandLogFields(sandboxId, command));
  if (command.workspacePath && !workspacePathsMatch(command.workspacePath, nodeWorkspacePath)) {
    throw new Error(
      `Daemon workspace mismatch: command expects ${command.workspacePath} but this daemon serves ${nodeWorkspacePath}.`,
    );
  }
  const threadWorkspace = command.workspaceLayout === "thread"
    ? threadWorkspaces.ensure(command.sessionId)
    : durableWorkspaceLayout(command.workspaceLayout)
      ? threadWorkspaces.ensureSubpath(command.sessionId, requiredWorkspaceSubpath(command))
      : threadWorkspaces.nodeRoot(command.sessionId);
  // executeCommand is inside WorkspaceRunGate. Validate before any receiver
  // preparation, cleanup, or agent execution can change the inherited files.
  const validation = validateHandoffWorkspace(threadWorkspace.hostPath, command);
  if (validation) state.prior_conversation = [state.prior_conversation, validation].filter(Boolean).join("\n\n");
  // The backend names the deliverables directory; a command from an older
  // backend carries none and keeps `artifacts/`. Null is a project: its
  // directory is the deliverable location, so no `artifacts/` is created.
  const artifactsDir = command.artifactsDir === undefined ? DEFAULT_ARTIFACTS_DIR : command.artifactsDir;
  threadWorkspaces.ensureRecords(threadWorkspace, artifactsDir);
  if (artifactsDir === null) {
    delete state.artifacts_dir;
    state.deliverables_in_workspace = true;
  } else {
    state.artifacts_dir = artifactsDir;
    delete state.deliverables_in_workspace;
  }
  if (state.progress_file === `threads/${command.sessionId}/HANDOFF.md`) {
    state.legacy_progress_file = command.workspaceLayout === "thread"
      ? "HANDOFF.md"
      : `HANDOFF-${command.sessionId}.md`;
  }
  // Discard control state from an interrupted previous run before execution.
  consumeRoundResult(threadWorkspace.hostPath);
  syncProjectContext(threadWorkspace.hostPath, command.workspaceLayout, state.project_brief);
  consumeProjectSetup(threadWorkspace.hostPath, state.project_setup?.file);
  // The lease pins the guest that mounts this workspace for the whole run, so
  // a concurrent run on another thread cannot recycle it mid-execution.
  const execution = await environment.acquireWorkspace(threadWorkspace.hostPath, signal);
  try {
    return await runInWorkspace(execution);
  } finally {
    execution.release();
  }

  /**
   * A local, native-policy run asks a person before using a tool, through the
   * permission adapter its registry entry names. The broker lives exactly as
   * long as the run; every other run is unchanged.
   */
  async function runWithPermissionPrompts<T>(runState: AgentState, run: (state: AgentState) => Promise<T>): Promise<T> {
    const support = getAgent(command.agent).permissionPrompts;
    if (support.kind !== "adapter" || !permissionPromptsApply(command.agent, environment.sandboxMode)) return await run(runState);
    let broker;
    try {
      broker = await startPermissionBroker({
        fetchFn,
        backendUrl,
        sandboxId,
        token,
        command,
        postEvent: (event, eventSignal) => postJsonWithRetry(fetchFn, eventUrl, event, token, eventSignal),
        signal,
        logger,
      });
    } catch (error) {
      // Never fall back to the runtime's headless command: Pi and Kimi there
      // run every tool without asking anyone, which a native policy forbids.
      const message = error instanceof Error ? error.message : String(error);
      logger.warn("permission broker unavailable; the run cannot ask a person", {
        ...commandLogFields(sandboxId, command),
        error: message,
      });
      throw new Error(`Relay could not start the permission prompt for this run: ${message}`);
    }
    try {
      return await run({ ...runState, permission_prompt: permissionAdapterLaunch(support.adapter, broker) });
    } finally {
      await broker.close();
    }
  }

  async function runInWorkspace(execution: WorkspaceExecution): Promise<DaemonNodeEvent> {
    await execution.ensureAgentReady(command.agent, signal);
    if (signal?.aborted) {
      return runCancelledEvent(command, signal.reason);
    }
    logger.info("agent ready", commandLogFields(sandboxId, command));
    const executionAgentHome = environment.sandboxMode === "boxlite" ? "/home/agent" : agentHomePath();
    const delivery = getAgent(command.agent).skillDelivery;
    const materialized = await materializeSkills({
      bundle: command.skills,
      agentId: command.logicalAgentId ?? `${command.agent}:${command.sessionId}`,
      delivery: environment.sandboxMode === "none" && delivery.kind === "config-dir"
        ? { kind: "prompt-paths" }
        : delivery,
      agentHome: executionAgentHome,
      cacheDir: join(executionAgentHome, ".relay", "managed-skills"),
      execStream: execution.execStream,
      signal,
      fetchBlob: async (sha) => {
        const url = relayApiUrl(
          backendUrl,
          `/daemon-nodes/${encodeURIComponent(sandboxId)}/skill-blobs/${sha}?commandId=${encodeURIComponent(command.id)}`,
        );
        const response = await fetchFn(url, { headers: { Authorization: `Bearer ${token}` }, signal: requestSignal(signal) });
        if (!response.ok) throw new Error(`skill blob unavailable (${response.status})`);
        return Buffer.from(await response.arrayBuffer());
      },
    });
    let outputSequence = 0;
    let outputPostFailure: Error | undefined;
    // Batches the backend refused outright. A refusal is about the batch, not
    // the run, so the run keeps its exit status and is only flagged as gappy.
    let outputBatchesRejected = 0;
    const maxOutputBacklogBytes = positiveIntEnv("RELAY_DAEMON_OUTPUT_BACKLOG_BYTES") ?? 16_777_216;
    const outputPostQueue: Array<{ post: () => Promise<void>; fields: DaemonLogFields; bytes: number }> = [];
    let outputPostHead = 0;
    let outputPostBacklogBytes = 0;
    let outputPostDrain: Promise<void> | undefined;
    const drainOutputPosts = async (): Promise<void> => {
      while (outputPostHead < outputPostQueue.length && !outputPostFailure) {
        const item = outputPostQueue[outputPostHead++];
        try {
          await item.post();
        } catch (error) {
          if (isRejectedOutputBatch(error)) {
            outputBatchesRejected += 1;
            logger.warn("output batch rejected; continuing without it", {
              ...commandLogFields(sandboxId, command),
              ...item.fields,
              status: error.status,
              error: error.message,
            });
          } else {
            outputPostFailure = error instanceof Error ? error : new Error(String(error));
            logger.error("event post exhausted retries", {
              ...commandLogFields(sandboxId, command),
              ...item.fields,
              error: outputPostFailure.message,
            });
          }
        } finally {
          outputPostBacklogBytes = Math.max(0, outputPostBacklogBytes - item.bytes);
        }
        // Output held back while this post was in flight goes out as one batch.
        if (outputPostHead >= outputPostQueue.length && !outputPostFailure) outputBuffer.resume();
      }
      outputPostQueue.length = 0;
      outputPostHead = 0;
    };
    const startOutputDrain = (): void => {
      if (outputPostDrain || outputPostFailure || outputPostQueue.length === 0) return;
      outputPostDrain = drainOutputPosts().finally(() => {
        outputPostDrain = undefined;
        startOutputDrain();
      });
    };
    const enqueueOutputPost = (
      post: () => Promise<void>,
      fields: DaemonLogFields,
      bytes: number,
    ): void => {
      if (outputPostFailure) return;
      if (outputPostBacklogBytes + bytes > maxOutputBacklogBytes) {
        outputPostFailure = new Error(
          `Output delivery backlog exceeded ${maxOutputBacklogBytes} bytes.`,
        );
        outputPostQueue.length = outputPostHead;
        return;
      }
      outputPostBacklogBytes += bytes;
      outputPostQueue.push({ post, fields, bytes });
      startOutputDrain();
    };
    const waitForOutputPosts = async (): Promise<void> => {
      while (outputPostDrain) await outputPostDrain;
    };
    const emitOutputBatch = (agent: AgentName, buffered: BufferedOutput[]): void => {
      const entries = buffered.map(({ stream, text }) => {
        const sequence = outputSequence++;
        logger.output({
          ...commandLogFields(sandboxId, command),
          agent,
          stream,
          text,
          sequence,
        });
        return { stream, text, sequence };
      });
      const event = {
            type: "run.output.batch",
            commandId: command.id,
            ...commandLeaseEventFields(command),
            sessionId: command.sessionId,
            runId: command.runId,
            agent,
            entries,
          } satisfies DaemonNodeEvent;
      if (outputPostFailure) return;
      try { persistTerminalEvent(fetchFn, event); } catch (error) {
        outputPostFailure = error instanceof Error ? error : new Error(String(error));
        return;
      }
      enqueueOutputPost(
        () => postJsonWithRetry(fetchFn, eventUrl, event, token, signal),
        { agent, sequence: entries[0]?.sequence },
        entries.reduce((total, entry) => total + Buffer.byteLength(entry.text), 0),
      );
    };
    // Batches are posted one at a time. While one is in flight the buffer keeps
    // collecting, so a slow backend gets fewer, larger posts instead of a queue
    // that grows by one post (and one durable record) every latency window.
    const outputBuffer = new OutputEventBuffer(
      (entries) => emitOutputBatch(command.agent, entries),
      { isBusy: () => outputPostDrain !== undefined },
    );
    const eventSink = {
      agentOutput: (_runId: string, _agent: AgentName, stream: "stdout" | "stderr", text: string): void => {
        outputBuffer.push(stream, text);
      },
      agentCollaboration: (_runId: string, agent: AgentName, collaboration: CodexCollaborationEvent): void => {
        // Keep structured collaboration events behind all output that preceded
        // them in the agent's JSONL stream.
        outputBuffer.flush();
        const sequence = outputSequence++;
        const event = {
              type: "run.collaboration",
              commandId: command.id,
              ...commandLeaseEventFields(command),
              sessionId: command.sessionId,
              runId: command.runId,
              agent,
              collaboration,
              sequence,
            } satisfies DaemonNodeEvent;
        if (outputPostFailure) return;
        try { persistTerminalEvent(fetchFn, event); } catch (error) {
          outputPostFailure = error instanceof Error ? error : new Error(String(error));
          return;
        }
        enqueueOutputPost(
          () => postJsonWithRetry(fetchFn, eventUrl, event, token, signal),
          { agent, sequence },
          Buffer.byteLength(JSON.stringify(collaboration)),
        );
      },
    };
    // Runs in one thread collaborate through that thread's directory. Different
    // threads never share a writable cwd. Each logical agent keeps a private
    // subdirectory inside the thread workspace.
    const agentHomeSubdir = command.logicalAgentId
      ? agentWorkspaceSubpath(command.logicalAgentId).split(sep).join("/")
      : undefined;
    if (command.logicalAgentId) {
      ensureAgentWorkspaceDir(threadWorkspace.hostPath, command.logicalAgentId);
    }
    const scanOptions = { ownAgentHomeSubdir: agentHomeSubdir, ownThreadId: command.sessionId };
    const options = {
      execStream: execution.execStream,
      eventSink,
      runId: command.runId,
      agent: command.agent,
      signal,
      workspacePath: threadWorkspace.executionPath,
      // A no-op sink keeps rendered agent text off the daemon's own stdout and
      // stderr; live output still flows through eventSink to the backend and the
      // JSONL run log. Supervisors set this so their logs stay lifecycle-only.
      ...(echoAgentOutput ? {} : { sink: () => undefined }),
    };
    const skillState = command.skills === undefined
      ? state
      : { ...state, skill_paths: materialized.skillPaths, skill_env: materialized.env };
    const runState = agentHomeSubdir
      ? { ...skillState, agent_home_subdir: agentHomeSubdir }
      : skillState;
    // Snapshot document-type workspace files so a successful run can report
    // exactly what it created or changed (see generated-files.ts).
    const workspaceSnapshot = snapshotGeneratedFiles(threadWorkspace.hostPath, scanOptions);
    let patch;
    try {
      if (command.reportExecutionStarted) {
        await postJsonWithRetry(fetchFn, eventUrl, {
          type: "run.executing",
          commandId: command.id,
          ...commandLeaseEventFields(command),
          sessionId: command.sessionId,
          runId: command.runId,
          agent: command.agent,
          ...((command.skillsSkipped?.length || materialized.skipped.length) ? {
            skillsSkipped: [...(command.skillsSkipped ?? []), ...materialized.skipped],
          } : {}),
        } satisfies DaemonNodeEvent, token, signal);
      }
      patch = await runWithPermissionPrompts(runState, (promptState) => runAgentNode(command.agent, promptState, options));
    } catch (error) {
      consumeRoundResult(threadWorkspace.hostPath);
      consumeProjectSetup(threadWorkspace.hostPath, state.project_setup?.file);
      throw error;
    } finally {
      outputBuffer.close();
      await waitForOutputPosts();
    }
    const next = mergeAgentState(state, patch);
    const agentLog = next.agent_logs.slice(-1)[0] ?? "";
    // Consume on every terminal path, including cancellation and delivery failure.
    const roundOutcome = readRoundResult(threadWorkspace.hostPath, command.runId);
    const roundResult = roundOutcome.kind === "accepted" ? roundOutcome.result : undefined;
    if (roundOutcome.kind === "rejected") {
      // Never log the file itself: it is agent-written and may carry anything.
      logger.warn("round result rejected", {
        ...commandLogFields(sandboxId, command),
        reason: roundOutcome.reason,
      });
    }
    const projectSetup = consumeProjectSetup(threadWorkspace.hostPath, state.project_setup?.file);
    if (signal?.aborted) {
      logger.info("run cancelled", {
        ...commandLogFields(sandboxId, command),
        exitCode: next.last_exit_code,
      });
      return runCancelledEvent(command, signal.reason, agentLog, next.token_usage, next.runtime_session_id);
    }
    // Output delivery can fail after the agent process has successfully written
    // its deliverables. Preserve those files on the terminal failure event so
    // the backend can still index them for the thread Space.
    const generatedFiles = next.last_exit_code === 0
      ? diffGeneratedFiles(threadWorkspace.hostPath, workspaceSnapshot, scanOptions)
      : [];
    if (outputPostFailure) {
      return {
        type: "run.failed",
        commandId: command.id,
        ...commandLeaseEventFields(command),
        sessionId: command.sessionId,
        runId: command.runId,
        agent: command.agent,
        error: `Daemon lost agent output: ${outputPostFailure.message}`,
        agentLog,
        exitCode: next.last_exit_code || 1,
        ...(next.token_usage ? { tokenUsage: next.token_usage } : {}),
        ...(generatedFiles.length > 0 ? { generatedFiles } : {}),
        ...(next.runtime_session_id ? { runtimeSessionId: next.runtime_session_id } : {}),
      } satisfies DaemonNodeEvent;
    }
    logger.info("run completed", {
      ...commandLogFields(sandboxId, command),
      exitCode: next.last_exit_code,
      agentLogBytes: agentLog.length,
      generatedFileCount: generatedFiles.length,
    });
    return {
      type: "run.completed",
      commandId: command.id,
      ...commandLeaseEventFields(command),
      sessionId: command.sessionId,
      runId: command.runId,
      agent: command.agent,
      exitCode: next.last_exit_code,
      agentLog,
      tokenUsage: next.token_usage,
      ...(generatedFiles.length > 0 ? { generatedFiles } : {}),
      ...(roundResult ? { roundResult } : {}),
      ...(roundOutcome.kind === "rejected" ? { roundResultRejected: { reason: roundOutcome.reason } } : {}),
      ...(outputBatchesRejected > 0 ? { outputTruncated: true } : {}),
      ...(next.runtime_session_id ? { runtimeSessionId: next.runtime_session_id } : {}),
      ...(projectSetup && state.project_setup ? { projectSetup } : {}),
    } satisfies DaemonNodeEvent;
  }
}

function runCancelledEvent(
  command: DaemonNodeRunCommand,
  reason: unknown,
  agentLog?: string,
  tokenUsage?: TokenUsage,
  runtimeSessionId?: string,
): DaemonNodeEvent {
  return {
    type: "run.cancelled",
    commandId: command.id,
    ...commandLeaseEventFields(command),
    sessionId: command.sessionId,
    runId: command.runId,
    agent: command.agent,
    reason: typeof reason === "string" && reason ? reason : "Cancelled by human.",
    ...(agentLog ? { agentLog } : {}),
    ...(tokenUsage ? { tokenUsage } : {}),
    ...(runtimeSessionId ? { runtimeSessionId } : {}),
  };
}

function commandLeaseEventFields(command: DaemonNodeRunCommand): { leaseId?: string } {
  return command.leaseId ? { leaseId: command.leaseId } : {};
}

/** One run's hold on the execution context that mounts its workspace. */
export interface WorkspaceExecution {
  ensureAgentReady(agent: AgentName, signal?: AbortSignal): Promise<void>;
  execStream: typeof localProcessExecStream;
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
  maxConcurrentRuns = 1,
): DaemonExecutionEnvironment {
  if (mode === "boxlite") {
    return createBoxliteEnvironment(sandboxId, workspacePath, logger, { maxGuests: maxConcurrentRuns });
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
    boxName: (slot) => boxNameForSandbox(sandboxId, slot),
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
        throw new Error(`The sandbox did not start: ${error instanceof Error ? error.message : String(error)}`);
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
        await runtimeOwner.close();
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
      sandboxId, error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

function boxNameForSandbox(sandboxId: string, slot = 0): string {
  const base = `relay-${sandboxId.replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 48)}`;
  // Slot 0 keeps the historical name so an upgraded daemon reclaims its box.
  return slot === 0 ? base : `${base}-${slot}`;
}


function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Delay aborted."));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(new Error("Delay aborted."));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
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
  input: { waitSeconds: number; leaseSeconds: number; activeCommandLeases: Array<{ commandId: string; leaseId?: string }> },
): string {
  const url = new URL(relayApiUrl(backendUrl, `/daemon-nodes/${encodeURIComponent(sandboxId)}/commands`));
  url.searchParams.set("waitSeconds", formatQueryNumber(input.waitSeconds));
  url.searchParams.set("leaseSeconds", formatQueryNumber(input.leaseSeconds));
  url.searchParams.set("leaseMode", "explicit");
  url.searchParams.set("limit", "10");
  for (const { commandId, leaseId } of input.activeCommandLeases) {
    if (leaseId) url.searchParams.append("activeCommandLease", `${commandId}:${leaseId}`);
  }
  return url.toString();
}

function formatQueryNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
}

function canStartCommand(
  activeRuns: Map<string, { command: DaemonNodeRunCommand }>,
  maxConcurrentRuns: number,
  terminalCommands: Set<string>,
): boolean {
  return [...activeRuns.keys()].filter((id) => !terminalCommands.has(id)).length < maxConcurrentRuns;
}

export function createDaemonLogger(input: {
  workspacePath: string;
  sandboxId: string;
  logDir?: string;
}): DaemonLogger {
  const logDir = input.logDir
    ?? join(homedir(), ".relay", "daemon-nodes", safeLogFileName(input.sandboxId), "logs");
  mkdirSync(logDir, { recursive: true, mode: 0o700 });
  chmodSync(logDir, 0o700);
  const logPath = join(logDir, `${safeLogFileName(input.sandboxId)}.jsonl`);
  return new JsonlDaemonLogger(logDir, logPath);
}

class JsonlDaemonLogger implements DaemonLogger {
  private pendingWrite: Promise<void> = Promise.resolve();

  constructor(
    private readonly logDir: string,
    public readonly logPath: string,
  ) {}

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
    this.write("output", "agent output", fields);
  }

  private write(level: string, message: string, fields: DaemonLogFields): void {
    const entry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      ...fields,
    };
    const line = `${JSON.stringify(entry)}\n`;
    const paths = [this.logPath];
    if (typeof fields.runId === "string" && fields.runId) {
      paths.push(join(this.logDir, `${safeLogFileName(fields.runId)}.jsonl`));
    }
    this.pendingWrite = this.pendingWrite
      .then(async () => {
        await Promise.all(paths.map((path) => appendFile(path, line, "utf8")));
      })
      .catch((error: unknown) => {
        process.stderr.write(`Relay daemon log write failed: ${error instanceof Error ? error.message : String(error)}\n`);
      });
  }

  async flush(): Promise<void> {
    await this.pendingWrite;
  }

  async close(): Promise<void> {
    await this.flush();
  }
}

function commandLogFields(sandboxId: string, command: DaemonNodeRunCommand): DaemonLogFields {
  return {
    sandboxId,
    commandId: command.id,
    sessionId: command.sessionId,
    runId: command.runId,
    agent: command.agent,
  };
}

function refreshCommandLease(active: DaemonNodeRunCommand, received: DaemonNodeRunCommand): void {
  if (received.leaseId) active.leaseId = received.leaseId;
  if (received.leaseExpiresAt) active.leaseExpiresAt = received.leaseExpiresAt;
  if (received.attempt !== undefined) active.attempt = received.attempt;
}

function safeLogFileName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "_") || "daemon-node";
}

function workspacePathsMatch(a?: string, b?: string): boolean {
  const left = normalizeWorkspacePath(a);
  const right = normalizeWorkspacePath(b);
  return Boolean(left && right && left === right);
}

function normalizeWorkspacePath(value?: string): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? resolve(trimmed) : undefined;
}

const REQUEST_TIMEOUT_MS = 30_000;
/** Room for one round trip on a slow link; well inside launchd's 20 s exit timeout. */
const SHUTDOWN_REGISTRATION_TIMEOUT_MS = 2_500;
const SHUTDOWN_TERMINAL_EVENT_TIMEOUT_MS = 500;
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

function requestSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export class DaemonHttpError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = "DaemonHttpError";
  }
}

class DaemonStoppedError extends Error {
  constructor() {
    super("Relay daemon stopped.");
    this.name = "DaemonStoppedError";
  }
}

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
    throw new DaemonHttpError(`POST ${url} failed: ${response.status} ${await responseErrorDetail(response)}`, response.status);
  }
  const body = await response.json() as Partial<ManagedDaemonEnrollment>;
  if (!body.sandboxId || !body.token) throw new Error("Managed daemon enrollment response is incomplete.");
  return body as ManagedDaemonEnrollment;
}

// Retries `action` while the backend is unreachable (network errors) or
// answering with 5xx, with capped exponential backoff. Client errors (4xx,
// e.g. a rejected token) are fatal and propagate immediately.
const BACKEND_RECONNECT_MAX_DELAY_MS = 10_000;
const BACKEND_RECONNECT_BASE_DELAY_MS = 2_000;

export function backendReconnectDelayMs(attempt: number, random = Math.random): number {
  const ceiling = Math.min(
    BACKEND_RECONNECT_BASE_DELAY_MS * 2 ** Math.min(Math.max(attempt - 1, 0), 3),
    BACKEND_RECONNECT_MAX_DELAY_MS,
  );
  // Equal jitter keeps a meaningful lower bound while spreading reconnecting daemons.
  return Math.round(ceiling * (0.5 + random() * 0.5));
}

async function withBackendReconnect<T>(
  action: () => Promise<T>,
  logger: Pick<DaemonLogger, "warn">,
  context: { sandboxId: string; what: string },
  control: {
    signal?: AbortSignal;
    shouldStop?: () => boolean;
    onTransientFailure?: () => void;
    onCredentialRejected?: () => void;
  } = {},
): Promise<T> {
  let attempt = 0;
  while (true) {
    if (control.signal?.aborted || control.shouldStop?.()) throw new DaemonStoppedError();
    try {
      return await action();
    } catch (error) {
      if (control.signal?.aborted || control.shouldStop?.()) throw new DaemonStoppedError();
      if (error instanceof DaemonHttpError && error.status < 500 && error.status !== 408 && error.status !== 429) {
        // Only the backend itself revoking credentials speaks for ownership. A
        // proxy's 403/404 mid-deploy says nothing about it, so it neither ends
        // nor starts an outage grace.
        if (error.status === 401 || error.status === 410) control.onCredentialRejected?.();
        throw error;
      }
      control.onTransientFailure?.();
      attempt += 1;
      const message = error instanceof Error ? error.message : String(error);
      const backoff = backendReconnectDelayMs(attempt);
      logger.warn(`${context.what} failed; retrying`, {
        sandboxId: context.sandboxId,
        error: message,
        attempt,
        backoffMs: backoff,
      });
      try {
        await delay(backoff, control.signal);
      } catch (delayError) {
        if (control.signal?.aborted || control.shouldStop?.()) throw new DaemonStoppedError();
        throw delayError;
      }
    }
  }
}

async function postJson(fetchFn: typeof fetch, url: string, body: unknown, token?: string, signal?: AbortSignal): Promise<void> {
  await postJsonRequest(fetchFn, url, body, token, signal);
}

async function postJsonResponse<T>(
  fetchFn: typeof fetch,
  url: string,
  body: unknown,
  token?: string,
  signal?: AbortSignal,
): Promise<T> {
  const response = await postJsonRequest(fetchFn, url, body, token, signal);
  return await response.json() as T;
}

async function postJsonRequest(
  fetchFn: typeof fetch,
  url: string,
  body: unknown,
  token?: string,
  signal?: AbortSignal,
): Promise<Response> {
  const response = await fetchFn(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
    signal: requestSignal(signal),
  });
  if (!response.ok) {
    throw new DaemonHttpError(`POST ${url} failed: ${response.status} ${await responseErrorDetail(response)}`, response.status);
  }
  return response;
}

function validHeartbeatSettings(
  value: DaemonNodeHeartbeatSettings | undefined,
): DaemonNodeHeartbeatSettings | undefined {
  if (!value || !Number.isFinite(value.intervalMs) || value.intervalMs <= 0) return undefined;
  if (!Number.isFinite(value.timeoutMs) || value.timeoutMs <= value.intervalMs) return undefined;
  return value;
}

/**
 * A definite refusal of one output batch (a 4xx other than the transient or
 * credential ones). postJsonWithRetry already retried everything else.
 */
function isRejectedOutputBatch(error: unknown): error is DaemonHttpError {
  return error instanceof DaemonHttpError
    && error.status >= 400 && error.status < 500
    && ![401, 408, 410, 429].includes(error.status);
}

const EVENT_POST_RETRY_INITIAL_DELAY_MS = 200;
const EVENT_POST_RETRY_MAX_DELAY_MS = 10_000;

async function postJsonWithRetry(
  fetchFn: typeof fetch,
  url: string,
  body: unknown,
  token: string,
  signal?: AbortSignal,
): Promise<void> {
  persistTerminalEvent(fetchFn, body);
  let attempt = 0;
  while (true) {
    if (signal?.aborted) throw new Error("Aborted before event post.");
    try {
      await postJson(fetchFn, url, body, token, signal);
      return;
    } catch (error) {
      if (error instanceof DaemonHttpError && error.status < 500 && error.status !== 408 && error.status !== 429) throw error;
      const backoff = Math.min(EVENT_POST_RETRY_INITIAL_DELAY_MS * 2 ** Math.min(attempt, 5), EVENT_POST_RETRY_MAX_DELAY_MS);
      attempt += 1;
      await delay(backoff, signal);
    }
  }
}

async function getJson(fetchFn: typeof fetch, url: string, token?: string, signal?: AbortSignal): Promise<Response> {
  return fetchFn(url, {
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    signal: requestSignal(signal),
  });
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
