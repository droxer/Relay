import { spawn } from "node:child_process";
import { accessSync, chmodSync, constants, mkdirSync, statSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";

import type {
  DaemonNodeCommand,
  DaemonNodeEvent,
  DaemonAgentHealth,
  DaemonNodeHeartbeatResponse,
  DaemonNodeHeartbeatSettings,
  DaemonNodeRegistration,
  DaemonNodeRegistrationResponse,
  DaemonNodeRunCommand,
  DaemonNodeSandboxMode,
  AgentName,
  StreamExecResult,
  CodexCollaborationEvent,
} from "relay-core";
import {
  startOrchestratorSession,
  ensureAgentReady as ensureSandboxAgentReady,
  resolveBoxliteHome,
  BoxliteRuntimeOwner,
  type ActiveOrchestratorSession,
} from "./sandbox-session.js";
import { diffGeneratedFiles, snapshotGeneratedFiles } from "./generated-files.js";
import { consumeRoundResult } from "./round-result.js";
import { agentWorkspaceSubpath, ensureAgentWorkspaceDir } from "./agent-workspace.js";
import { discoverAgentInventory } from "./agent-inventory.js";
import { defaultExecutionManager, type ExecutionManager } from "./execution.js";
import { ensureLocalDevboxOci, hasHostKimiCodeAuth, prepareHostAgentSkills, prepareHostKimiCodeHome } from "./box.js";

async function verifyBoxlitePrerequisites(sandboxId: string): Promise<void> {
  try {
    await import("@boxlite-ai/boxlite");
  } catch {
    console.error(`Relay daemon requires @boxlite-ai/boxlite to run in boxlite sandbox mode.`);
    console.error(`Run: npm install`);
    process.exit(1);
  }
  try {
    ensureLocalDevboxOci((text) => console.log(`  ${text.trimEnd()}`));
  } catch (error) {
    console.error(`Failed to prepare BoxLite devbox image for sandbox ${sandboxId}:`);
    console.error(error instanceof Error ? error.message : String(error));
    console.error(`Run: make devbox-oci`);
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
  ensureMachineId,
  GUEST_WORKSPACE,
  agentHomePath,
  agentCredentialEnv,
  allAgentCredentialEnvNames,
  DAEMON_CAPABILITY_GENERATED_FILES,
  DAEMON_CAPABILITY_PROJECT_WORKSPACES,
  DAEMON_CAPABILITY_ROUND_RESULT,
  DAEMON_CAPABILITY_STRUCTURED_AGENT_EVENTS,
  DAEMON_CAPABILITY_TASK_WORKSPACES,
  DAEMON_CAPABILITY_THREAD_WORKSPACES,
  DAEMON_CAPABILITY_WORKSPACE_READ_SHARED,
  DAEMON_NODE_PROTOCOL_VERSION,
  relayApiUrl,
} from "relay-core";
import { workspaceCommandEvent } from "./workspace-read.js";
import { ThreadWorkspaceManager } from "./thread-workspace.js";
import { OutputEventBuffer, type BufferedOutput } from "./output-event-buffer.js";
import { WorkspaceRunGate } from "./workspace-run-gate.js";
import { BoundedTextCapture } from "./bounded-text.js";

export type DaemonSandboxMode = DaemonNodeSandboxMode;
const DEFAULT_DAEMON_SANDBOX_MODE: DaemonSandboxMode = "boxlite";

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
  employeeId?: string;
  workspacePath?: string;
  workspaceId?: string;
  pollIntervalMs?: number;
  commandPollWaitMs?: number;
  commandLeaseSeconds?: number;
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
  logDir?: string;
  logger?: DaemonLogger;
  signal?: AbortSignal;
  shutdownGraceMs?: number;
  agentHome?: string;
  maxConcurrentRuns?: number;
  environment?: DaemonExecutionEnvironment;
  preflight?: boolean;
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
  const fetchFn = options.fetchFn ?? fetch;
  let sandboxId = options.sandboxId ?? process.env.RELAY_SANDBOX_ID;
  let configuredEmployeeId = options.employeeId ?? process.env.RELAY_EMPLOYEE_ID;
  const employeeId = configuredEmployeeId ?? process.env.USER ?? "local";
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
    const enrollment = await withBackendReconnect(
      () => enrollManagedDaemon(fetchFn, backendUrl, enrollmentToken, workspacePath, options.signal),
      options.logger ?? { warn: () => undefined },
      { sandboxId: "pending-managed-enrollment", what: "managed enrollment" },
      { signal: options.signal },
    );
    sandboxId = enrollment.sandboxId;
    enrolledToken = enrollment.token;
    configuredEmployeeId = configuredEmployeeId ?? enrollment.employeeId;
    enrolledSandboxMode = enrollment.sandboxMode;
    enrolledHeartbeatSettings = validHeartbeatSettings(enrollment.heartbeat);
  }
  if (!sandboxId) throw new Error("RELAY_SANDBOX_ID or RELAY_ENROLLMENT_TOKEN is required for the relay daemon.");
  const effectiveEmployeeId = configuredEmployeeId ?? employeeId;
  const sandboxMode = resolveSandboxMode(options.sandbox ?? process.env.RELAY_SANDBOX_MODE ?? enrolledSandboxMode);
  if (!options.environment) {
    assertHostAgentExecutionAllowed(
      sandboxMode,
      options.allowHostAgentExecution ?? process.env.RELAY_ALLOW_HOST_AGENT_EXECUTION === "1",
    );
  }
  const stateDir = resolveDaemonStateDirectory(sandboxId, options.stateDir);
  configureAgentProcessEnvironment(sandboxMode, workspacePath, options.agentHome);
  const tokenResolution = ensureDaemonNodeToken({
    credentialDirectory: join(stateDir, "credentials"),
    legacyWorkspacePath: workspacePath,
    employeeId: effectiveEmployeeId,
    token: options.token ?? process.env.RELAY_DAEMON_TOKEN ?? process.env.RELAY_DAEMON_NODE_TOKEN ?? enrolledToken,
  });
  const token = tokenResolution.token;
  const pollIntervalMs = options.pollIntervalMs ?? 1000;
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
  const environment = options.environment ?? createExecutionEnvironment(sandboxMode, sandboxId, workspacePath, logger);
  if (sandboxMode === "boxlite" && !options.environment) {
    await verifyBoxlitePrerequisites(sandboxId);
  }
  const threadWorkspaces = new ThreadWorkspaceManager(workspacePath, environment.sandboxMode);
  const workspaceRunGate = new WorkspaceRunGate(threadWorkspaces.rootPath);
  let health: DaemonHealthState | undefined;
  const setHealth = (next: DaemonHealthState, fields: DaemonLogFields = {}): void => {
    if (health === next) return;
    health = next;
    logger.info("daemon health", { sandboxId, health: next, ...fields });
  };
  logger.info("daemon starting", { sandboxId, employeeId: effectiveEmployeeId, workspacePath, backendUrl, sandboxMode });
  setHealth("starting", { employeeId: effectiveEmployeeId, workspacePath, backendUrl, sandboxMode });
  const requestedMaxConcurrentRuns = options.maxConcurrentRuns
    ?? positiveIntEnv("RELAY_DAEMON_MAX_CONCURRENT_RUNS")
    ?? 1;
  // The BoxLite adapter owns one active guest at a time. Serializing runs also
  // lets each guest mount only its active thread instead of the whole node root.
  const maxConcurrentRuns = sandboxMode === "boxlite" && !options.environment
    ? 1
    : requestedMaxConcurrentRuns;
  const activeRuns = new Map<string, { command: DaemonNodeRunCommand; controller: AbortController; promise: Promise<void> }>();
  const shutdownGraceMs = options.shutdownGraceMs ?? positiveIntEnv("RELAY_DAEMON_SHUTDOWN_GRACE_MS") ?? 10_000;
  const shutdownController = new AbortController();
  const runtimeSignal = options.signal
    ? AbortSignal.any([options.signal, shutdownController.signal])
    : shutdownController.signal;
  let stopping = false;
  let shutdownPromise: Promise<void> | undefined;
  // Set when the backend answers 410: the node was deleted in the control
  // panel, so this daemon stops instead of re-registering itself back in.
  let nodeDeleted = false;
  if (runtimeSignal.aborted) {
    setHealth("stopping", { signal: "external" });
    await environment.close();
    setHealth("stopped");
    await logger.close?.();
    return;
  }
  let agentHealth = await discoverDaemonAgentHealth(environment, logger, sandboxId, options.signal);
  let agentInventory = await discoverAgentInventory(environment.execStream, options.signal, inventoryDiscoveryTimeoutMs);
  const buildRegistration = (includeEmployeeId = Boolean(configuredEmployeeId), status?: DaemonNodeRegistration["status"]): DaemonNodeRegistration => ({
    sandboxId,
    ...(includeEmployeeId ? { employeeId: effectiveEmployeeId } : {}),
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
    capabilities: [
      DAEMON_CAPABILITY_GENERATED_FILES,
      DAEMON_CAPABILITY_WORKSPACE_READ_SHARED,
      DAEMON_CAPABILITY_STRUCTURED_AGENT_EVENTS,
      DAEMON_CAPABILITY_THREAD_WORKSPACES,
      DAEMON_CAPABILITY_PROJECT_WORKSPACES,
      DAEMON_CAPABILITY_TASK_WORKSPACES,
      DAEMON_CAPABILITY_ROUND_RESULT,
    ],
    agentHealth,
    ...(Object.keys(agentInventory).length > 0 ? { agentInventory } : {}),
    maxConcurrentRuns,
    status: status ?? (activeRuns.size > 0 ? "busy" : "ready"),
  });
  const register = async (): Promise<DaemonNodeHeartbeatSettings | undefined> => {
    const url = relayApiUrl(backendUrl, "/daemon-node-registrations");
    try {
      const response = await postJsonResponse<DaemonNodeRegistrationResponse>(
        fetchFn, url, buildRegistration(), undefined, runtimeSignal,
      );
      return validHeartbeatSettings(response.heartbeat);
    } catch (error) {
      if (
        error instanceof DaemonHttpError &&
        error.status === 400 &&
        error.message.includes("employeeId is required for unprovisioned daemon node registration")
      ) {
        const response = await postJsonResponse<DaemonNodeRegistrationResponse>(
          fetchFn, url, buildRegistration(true), undefined, runtimeSignal,
        );
        return validHeartbeatSettings(response.heartbeat);
      }
      throw error;
    }
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
      for (const active of activeRuns.values()) active.controller.abort(`Daemon received ${signal}.`);
      await Promise.race([
        Promise.allSettled([...activeRuns.values()].map((active) => active.promise)),
        delay(shutdownGraceMs),
      ]);
      // A deleted node has no record to mark stopped, and the backend rejects
      // the registration anyway. Skip it rather than log a bogus failure.
      if (!nodeDeleted) {
        await postJson(
          fetchFn,
          relayApiUrl(backendUrl, "/daemon-node-registrations"),
          buildRegistration(undefined, "stopped"),
          undefined,
          AbortSignal.timeout(SHUTDOWN_REGISTRATION_TIMEOUT_MS),
        ).catch((error: unknown) => {
          logger.warn("daemon stopped registration failed", { sandboxId, error: error instanceof Error ? error.message : String(error) });
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
  let heartbeatTask: Promise<void> | undefined;
  try {
    const reconnectControl = { signal: runtimeSignal, shouldStop: () => stopping };
    const initialHeartbeatSettings = await withBackendReconnect(
      register, logger, { sandboxId, what: "registration" }, reconnectControl,
    );
    let livenessHeartbeatIntervalMs = configuredLivenessHeartbeatIntervalMs
      ?? initialHeartbeatSettings?.intervalMs
      ?? enrolledHeartbeatSettings?.intervalMs
      ?? DEFAULT_LIVENESS_HEARTBEAT_MS;
    let lastRegisteredAt = Date.now();
    logger.info("daemon registered", { sandboxId, employeeId: effectiveEmployeeId, workspacePath, backendUrl, logPath: logger.logPath });
    setHealth("registered");
    console.log(`Relay daemon registered sandbox ${sandboxId} with backend at ${backendUrl} (sandbox: ${sandboxMode})`);
    if (logger.logPath) console.log(`Relay daemon log: ${logger.logPath}`);
    if (tokenResolution.source === "generated" && tokenResolution.path) {
      logger.info("daemon generated token", { sandboxId, employeeId: effectiveEmployeeId, path: tokenResolution.path });
      console.log(`Relay daemon generated token for ${effectiveEmployeeId}: ${tokenResolution.path}`);
    }

    setHealth("polling");
    const updateHeartbeatSettings = (settings: DaemonNodeHeartbeatSettings | undefined): void => {
      if (!settings) return;
      if (configuredLivenessHeartbeatIntervalMs === undefined) {
        livenessHeartbeatIntervalMs = settings.intervalMs;
      }
    };
    const sendHeartbeat = async (): Promise<void> => {
      const url = relayApiUrl(backendUrl, `/daemon-nodes/${encodeURIComponent(sandboxId)}/heartbeat`);
      try {
        const response = await postJsonResponse<DaemonNodeHeartbeatResponse>(
          fetchFn,
          url,
          {
            activeCommandLeases: [...activeRuns.values()].map(({ command }) => ({
              commandId: command.id,
              ...(command.leaseId ? { leaseId: command.leaseId } : {}),
            })),
          },
          token,
          runtimeSignal,
        );
        updateHeartbeatSettings(validHeartbeatSettings(response.heartbeat));
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
    heartbeatTask = (async () => {
      while (!stopping && !runtimeSignal.aborted) {
        await delay(livenessHeartbeatIntervalMs, runtimeSignal);
        if (stopping || runtimeSignal.aborted) return;
        await withBackendReconnect(
          sendHeartbeat,
          logger,
          { sandboxId, what: "liveness heartbeat" },
          reconnectControl,
        );
      }
    })().catch((error: unknown) => {
      if (stopping || runtimeSignal.aborted || error instanceof DaemonStoppedError) return;
      logger.error("liveness heartbeat stopped", {
        sandboxId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
    const cancellationTerminalEventSignal = (): AbortSignal | undefined =>
      stopping ? AbortSignal.timeout(SHUTDOWN_TERMINAL_EVENT_TIMEOUT_MS) : undefined;
    while (!stopping) {
      let completedEmptyLongPoll = false;
      const body = await withBackendReconnect(async () => {
        if (stopping) return { commands: [] };
        // Capability re-registration refreshes agent inventory independently
        // of the lightweight liveness heartbeat.
        if (activeRuns.size === 0 && Date.now() - lastRegisteredAt >= registrationRefreshIntervalMs) {
          agentHealth = await discoverDaemonAgentHealth(environment, logger, sandboxId, runtimeSignal);
          agentInventory = await discoverAgentInventory(environment.execStream, runtimeSignal, inventoryDiscoveryTimeoutMs);
          updateHeartbeatSettings(await register());
          lastRegisteredAt = Date.now();
        }
        const commandPollStartedAt = performance.now();
        const response = await getJson(
          fetchFn,
          daemonCommandsUrl(backendUrl, sandboxId, {
            waitSeconds: commandPollWaitMs / 1000,
            leaseSeconds: commandLeaseSeconds,
            activeCommandLeases: [...activeRuns.values()].map(({ command }) => ({
              commandId: command.id,
              leaseId: command.leaseId,
            })),
          }),
          token,
          runtimeSignal,
        );
        if (!response.ok) {
          // The backend may have restarted with fresh state or demoted this node;
          // re-register before treating the rejection as fatal.
          const detail = `Command poll failed: ${response.status} ${await response.text()}`;
          logger.warn("command poll rejected; re-registering", { sandboxId, error: detail });
          await register();
          lastRegisteredAt = Date.now();
          logger.info("daemon re-registered", { sandboxId });
          return { commands: [] };
        }
        const parsed = await response.json() as { commands?: DaemonNodeCommand[] };
        completedEmptyLongPoll = commandPollWaitMs > 0
          && (parsed.commands?.length ?? 0) === 0
          && performance.now() - commandPollStartedAt >= commandPollWaitMs;
        return parsed;
      }, logger, { sandboxId, what: "command poll" }, reconnectControl);
      if (stopping) break;
      for (const command of body.commands ?? []) {
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
          if (!canStartCommand(activeRuns, maxConcurrentRuns)) {
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
                ? undefined
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
          const controller = new AbortController();
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
              cancellationTerminalEventSignal,
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
          ).catch(async (error: unknown) => {
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
            activeRuns.delete(command.id);
            if (!stopping) setHealth("polling");
          });
          activeRuns.set(command.id, { command, controller, promise });
        } else if (command.type === "run.cancel") {
          logger.info("cancel command received", {
            sandboxId,
            commandId: command.commandId,
            sessionId: command.sessionId,
            runId: command.runId,
            agent: command.agent,
          });
          activeRuns.get(command.commandId)?.controller.abort(command.reason);
        } else if (command.type === "workspace.list" || command.type === "workspace.read") {
          // A durable workspaceSubpath is validated before the workspace-read helpers
          // run, so an escaping subpath throws here rather than inside workspaceCommandEvent —
          // catch it the same way, as a workspace.error event, instead of letting it
          // fall out of the poll loop and take the whole daemon down.
          let event: DaemonNodeEvent;
          try {
            const commandWorkspacePath = durableWorkspaceLayout(command.workspaceLayout) && command.sessionId
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
    if (error instanceof DaemonHttpError && error.status === 410) {
      nodeDeleted = true;
      logger.info("daemon node deleted; stopping", { sandboxId, error: error.message });
      console.log(`Relay daemon stopping: node ${sandboxId} was deleted in the control panel.`);
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
    await heartbeatTask;
    cleanupShutdownListeners();
  }
}

export async function runRelayDaemonDoctor(options: DaemonRuntimeOptions = {}): Promise<DaemonDoctorReport> {
  const backendUrl = normalizeBaseUrl(options.backendUrl ?? process.env.RELAY_BACKEND_URL ?? process.env.RELAY_DAEMON_URL ?? "http://127.0.0.1:8790");
  const sandboxId = options.sandboxId ?? process.env.RELAY_SANDBOX_ID;
  const configuredEmployeeId = options.employeeId ?? process.env.RELAY_EMPLOYEE_ID;
  const employeeId = configuredEmployeeId ?? process.env.USER ?? "local";
  const workspacePath = firstNonBlank(options.workspacePath, process.env.RELAY_WORKSPACE, process.env.WORKSPACE) ?? process.cwd();
  const sandboxMode = resolveSandboxMode(options.sandbox ?? process.env.RELAY_SANDBOX_MODE);
  if (!options.environment) {
    assertHostAgentExecutionAllowed(
      sandboxMode,
      options.allowHostAgentExecution ?? process.env.RELAY_ALLOW_HOST_AGENT_EXECUTION === "1",
    );
  }
  const stateDir = resolveDaemonStateDirectory(sandboxId ?? "doctor", options.stateDir);
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
    token = ensureDaemonNodeToken({
      credentialDirectory: join(stateDir, "credentials"),
      legacyWorkspacePath: workspacePath,
      employeeId,
      token: options.token ?? process.env.RELAY_DAEMON_TOKEN ?? process.env.RELAY_DAEMON_NODE_TOKEN,
    }).token;
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
    await postJson(fetchFn, relayApiUrl(backendUrl, "/daemon-node-registrations"), {
      sandboxId,
      ...(configuredEmployeeId ? { employeeId } : {}),
      token,
      workspacePath,
      sandboxMode,
      protocolVersion: DAEMON_NODE_PROTOCOL_VERSION,
      supportedAgents: readyAgents(agentHealth),
      agentHealth,
      status: "stopped",
    } satisfies DaemonNodeRegistration).then(
      () => add("registration", true, "backend accepted daemon node registration."),
      (error: unknown) => add("registration", false, error instanceof Error ? error.message : String(error)),
    );
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
    // Local nodes discover and run the employee's existing host agents. An
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
): Promise<Partial<Record<AgentName, DaemonAgentHealth>>> {
  const health: Partial<Record<AgentName, DaemonAgentHealth>> = {};
  for (const agent of AGENT_NAMES) {
    const def = getAgent(agent);
    try {
      await environment.ensureAgentReady(agent, signal);
      health[agent] = {
        status: "ready",
        detail: `${def.displayName} preflight passed.`,
        adapter: "cli",
      };
      logger.info("agent capability ready", { sandboxId, agent });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      health[agent] = {
        status: "failed",
        detail,
        adapter: "cli",
      };
      logger.warn("agent capability failed", { sandboxId, agent, error: detail });
    }
  }
  return health;
}

function readyAgents(health: Partial<Record<AgentName, DaemonAgentHealth>>): AgentName[] {
  return AGENT_NAMES.filter((agent) => health[agent]?.status === "ready");
}

async function checkBackendReachable(fetchFn: typeof fetch, backendUrl: string, signal?: AbortSignal): Promise<void> {
  const url = `${backendUrl}/api`;
  const response = await fetchFn(url, { signal: requestSignal(signal) });
  if (!response.ok) {
    throw new DaemonHttpError(`GET ${url} failed: ${response.status} ${await response.text()}`, response.status);
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
  cancellationTerminalEventSignal?: () => AbortSignal | undefined,
): Promise<void> {
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
  // Discard control state from an interrupted previous run before execution.
  consumeRoundResult(threadWorkspace.hostPath);
  await environment.ensureAgentReady(command.agent, signal, threadWorkspace.hostPath);
  if (signal?.aborted) {
    await postRunCancelled(fetchFn, eventUrl, command, token, signal.reason, cancellationTerminalEventSignal?.()).catch((error: unknown) => {
      logger.error("terminal event post failed", {
        ...commandLogFields(sandboxId, command),
        error: error instanceof Error ? error.message : String(error),
      });
    });
    return;
  }
  logger.info("agent ready", commandLogFields(sandboxId, command));
  let outputSequence = 0;
  let outputPostFailure: Error | undefined;
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
        outputPostFailure = error instanceof Error ? error : new Error(String(error));
        logger.error("event post exhausted retries", {
          ...commandLogFields(sandboxId, command),
          ...item.fields,
          error: outputPostFailure.message,
        });
      } finally {
        outputPostBacklogBytes = Math.max(0, outputPostBacklogBytes - item.bytes);
      }
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
    enqueueOutputPost(
      () => postJsonWithRetry(fetchFn, eventUrl, {
          type: "run.output.batch",
          commandId: command.id,
          ...commandLeaseEventFields(command),
          sessionId: command.sessionId,
          runId: command.runId,
          agent,
          entries,
        } satisfies DaemonNodeEvent, token, signal),
      { agent, sequence: entries[0]?.sequence },
      entries.reduce((total, entry) => total + Buffer.byteLength(entry.text), 0),
    );
  };
  const outputBuffer = new OutputEventBuffer(
    (entries) => emitOutputBatch(command.agent, entries),
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
      enqueueOutputPost(
        () => postJsonWithRetry(fetchFn, eventUrl, {
            type: "run.collaboration",
            commandId: command.id,
            ...commandLeaseEventFields(command),
            sessionId: command.sessionId,
            runId: command.runId,
            agent,
            collaboration,
            sequence,
          } satisfies DaemonNodeEvent, token, signal),
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
  const scanOptions = { ownAgentHomeSubdir: agentHomeSubdir };
  const options = {
    execStream: environment.execStream,
    eventSink,
    runId: command.runId,
    agent: command.agent,
    signal,
    workspacePath: threadWorkspace.executionPath,
  };
  const runState = agentHomeSubdir
    ? { ...state, agent_home_subdir: agentHomeSubdir }
    : state;
  // Snapshot document-type workspace files so a successful run can report
  // exactly what it created or changed (see generated-files.ts).
  const workspaceSnapshot = snapshotGeneratedFiles(threadWorkspace.hostPath, scanOptions);
  let patch;
  try {
    patch = await runAgentNode(command.agent, runState, options);
  } catch (error) {
    consumeRoundResult(threadWorkspace.hostPath);
    throw error;
  } finally {
    outputBuffer.close();
    await waitForOutputPosts();
  }
  const next = mergeAgentState(state, patch);
  const agentLog = next.agent_logs.slice(-1)[0] ?? "";
  // Consume on every terminal path, including cancellation and delivery failure.
  const roundResult = consumeRoundResult(threadWorkspace.hostPath, command.runId);
  if (signal?.aborted) {
    logger.info("run cancelled", {
      ...commandLogFields(sandboxId, command),
      exitCode: next.last_exit_code,
    });
    await postRunCancelled(fetchFn, eventUrl, command, token, signal.reason, cancellationTerminalEventSignal?.(), agentLog).catch((error: unknown) => {
      logger.error("terminal event post failed", {
        ...commandLogFields(sandboxId, command),
        error: error instanceof Error ? error.message : String(error),
      });
    });
    return;
  }
  // Output delivery can fail after the agent process has successfully written
  // its deliverables. Preserve those files on the terminal failure event so
  // the backend can still index them for the thread Space.
  const generatedFiles = next.last_exit_code === 0
    ? diffGeneratedFiles(threadWorkspace.hostPath, workspaceSnapshot, scanOptions)
    : [];
  if (outputPostFailure) {
    await postJsonWithRetry(fetchFn, eventUrl, {
      type: "run.failed",
      commandId: command.id,
      ...commandLeaseEventFields(command),
      sessionId: command.sessionId,
      runId: command.runId,
      agent: command.agent,
      error: `Daemon lost agent output: ${outputPostFailure.message}`,
      agentLog,
      exitCode: next.last_exit_code || 1,
      ...(generatedFiles.length > 0 ? { generatedFiles } : {}),
    } satisfies DaemonNodeEvent, token, signal);
    return;
  }
  logger.info("run completed", {
    ...commandLogFields(sandboxId, command),
    exitCode: next.last_exit_code,
    agentLogBytes: agentLog.length,
    generatedFileCount: generatedFiles.length,
  });
  await postJsonWithRetry(fetchFn, eventUrl, {
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
  } satisfies DaemonNodeEvent, token, signal);
}

async function postRunCancelled(
  fetchFn: typeof fetch,
  eventUrl: string,
  command: DaemonNodeRunCommand,
  token: string,
  reason: unknown,
  signal?: AbortSignal,
  agentLog?: string,
): Promise<void> {
  await postJsonWithRetry(fetchFn, eventUrl, {
    type: "run.cancelled",
    commandId: command.id,
    ...commandLeaseEventFields(command),
    sessionId: command.sessionId,
    runId: command.runId,
    agent: command.agent,
    reason: typeof reason === "string" && reason ? reason : "Cancelled by human.",
    ...(agentLog ? { agentLog } : {}),
  } satisfies DaemonNodeEvent, token, signal);
}

function commandLeaseEventFields(command: DaemonNodeRunCommand): { leaseId?: string } {
  return command.leaseId ? { leaseId: command.leaseId } : {};
}

export interface DaemonExecutionEnvironment {
  readonly sandboxMode: DaemonSandboxMode;
  ensureAgentReady(agent: AgentName, signal?: AbortSignal, hostWorkspace?: string): Promise<void>;
  execStream: typeof localProcessExecStream;
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
): DaemonExecutionEnvironment {
  if (mode === "boxlite") return createBoxliteEnvironment(sandboxId, workspacePath, logger);
  return {
    sandboxMode: "none",
    ensureAgentReady: async (agent, signal) => ensureLocalAgentReady(agent, signal),
    execStream: localProcessExecStream,
    close: async () => undefined,
  };
}

async function ensureLocalAgentReady(agent: AgentName, signal?: AbortSignal): Promise<void> {
  const def = getAgent(agent);
  prepareLocalAgentSkills();
  const result = await localProcessExecStream("bash", ["-c", def.preflight.command()], {
    signal,
    env: Object.fromEntries(agentCredentialEnv(agent)),
  });
  if (result.exit_code !== 0) {
    const detail = (result.stderr || result.stdout || result.error_message || "").trim();
    throw new Error(`${def.preflight.label} preflight failed.${detail ? ` ${detail}` : ""}`);
  }
}

const LOCAL_AGENT_SKILL_DIRS = [".claude/skills", ".codex/skills", ".pi/skills", ".kimi/skills"];
let localSkillsPreparedFor: string | undefined;

/**
 * Mirror the configured skills into each CLI's inventory directory once per
 * daemon lifetime. A local node's agent home is the operator's real home
 * directory, so this writes into files they own — doing it on every run would
 * rewrite that tree continuously, and synchronously, in the run's hot path.
 */
function prepareLocalAgentSkills(): void {
  const home = agentHomePath();
  if (localSkillsPreparedFor === home) return;
  for (const relativeDir of LOCAL_AGENT_SKILL_DIRS) {
    prepareHostAgentSkills(join(home, relativeDir));
  }
  localSkillsPreparedFor = home;
}


export interface BoxliteEnvironmentOptions {
  boxliteHome?: string;
  executionManager?: ExecutionManager;
  runtimeOwner?: BoxliteRuntimeOwner;
}

export function createBoxliteEnvironment(
  sandboxId: string,
  workspacePath: string,
  logger: DaemonLogger,
  options: BoxliteEnvironmentOptions = {},
): DaemonExecutionEnvironment {
  let starting: Promise<ActiveOrchestratorSession> | undefined;
  let mountedWorkspace: string | undefined;
  const boxliteHome = resolveBoxliteHome(workspacePath, options.boxliteHome, sandboxId);
  const executionManager = options.executionManager ?? defaultExecutionManager;
  const runtimeOwner = options.runtimeOwner ?? new BoxliteRuntimeOwner(boxliteHome);
  const stop = async (): Promise<void> => {
    if (!starting) return;
    const pending = starting;
    starting = undefined;
    mountedWorkspace = undefined;
    try {
      const active = await pending;
      await active.close();
    } catch {
      // The sandbox never came up; nothing to tear down.
    }
  };
  // A new guest is started when work moves to another thread. Its only
  // workspace volume is that thread's host directory.
  const start = async (hostWorkspace = workspacePath): Promise<ActiveOrchestratorSession> => {
    const nextWorkspace = resolve(hostWorkspace);
    if (starting && mountedWorkspace === nextWorkspace) return starting;
    if (starting) await stop();
    mountedWorkspace = nextWorkspace;
    starting = startOrchestratorSession((text) => {
      logger.info("sandbox", { sandboxId, text: text.trimEnd() });
    }, {
      boxName: boxNameForSandbox(sandboxId),
      workspacePath: nextWorkspace,
      boxliteHome,
      runtimeOwner,
      executionManager,
    }).catch((error: unknown) => {
      starting = undefined;
      mountedWorkspace = undefined;
      throw error;
    });
    return starting;
  };
  return {
    sandboxMode: "boxlite",
    async ensureAgentReady(agent, signal, hostWorkspace) {
      await start(hostWorkspace);
      await ensureSandboxAgentReady(agent, undefined, signal, executionManager);
    },
    execStream: async (cmd, args = [], options = {}) => {
      await start(mountedWorkspace ?? workspacePath);
      return executionManager.execStream(cmd, args, options);
    },
    async close() {
      try {
        await stop();
      } finally {
        await runtimeOwner.close();
      }
    },
  };
}

function boxNameForSandbox(sandboxId: string): string {
  return `relay-${sandboxId.replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 48)}`;
}

export async function localProcessExecStream(
  cmd: string,
  args: string[] = [],
  options: {
    cwd?: string;
    stdoutRenderer?: (chunk: string) => string;
    stderrRenderer?: (chunk: string) => string;
    sink?: (text: string) => void;
    signal?: AbortSignal;
    env?: Record<string, string>;
  } = {},
): Promise<StreamExecResult> {
  if (options.signal?.aborted) {
    return {
      exit_code: -1,
      stdout: "",
      stderr: "",
      error_message: "Execution cancelled before start.",
    };
  }
  return new Promise((resolve) => {
    const detached = process.platform !== "win32";
    const child = spawn(cmd, args, {
      cwd: options.cwd,
      env: { ...localAgentSubprocessEnv(), ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
      detached,
    });
    const stdoutCapture = new BoundedTextCapture();
    const stderrCapture = new BoundedTextCapture();
    let killTimer: NodeJS.Timeout | undefined;
    const terminate = (signal: NodeJS.Signals): void => {
      if (detached && child.pid) {
        try {
          process.kill(-child.pid, signal);
          return;
        } catch {
          // Fall back to the direct child below if the process group is gone.
        }
      }
      child.kill(signal);
    };
    const abort = (): void => {
      terminate("SIGTERM");
      // Escalate in case the agent ignores SIGTERM.
      killTimer = setTimeout(() => terminate("SIGKILL"), SIGKILL_DELAY_MS);
      killTimer.unref?.();
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (text: string) => {
      stdoutCapture.append(text);
      const rendered = options.stdoutRenderer ? options.stdoutRenderer(text) : text;
      if (rendered) options.sink?.(rendered);
    });
    child.stderr.on("data", (text: string) => {
      stderrCapture.append(text);
      const rendered = options.stderrRenderer ? options.stderrRenderer(text) : text;
      if (rendered) options.sink?.(rendered);
    });
    child.on("close", (code) => {
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", abort);
      resolve({
        exit_code: code ?? -1,
        stdout: stdoutCapture.toString(),
        stderr: stderrCapture.toString(),
      });
    });
    child.on("error", (error) => {
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", abort);
      resolve({
        exit_code: -1,
        stdout: stdoutCapture.toString(),
        stderr: stderrCapture.toString(),
        error_message: error.message,
      });
    });
  });
}

const AGENT_SUBPROCESS_ENV_DENY = new Set([
  "DATABASE_URL",
  "RELAY_CONTROL_PANEL_VERSION",
  "RELAY_DATABASE_URL",
  "RELAY_DATA_DIR",
  "RELAY_EMPLOYEE_ID",
  "RELAY_ENROLLMENT_TOKEN",
  "RELAY_SANDBOX_ID",
  "RELAY_SANDBOX_MODE",
  "RELAY_STORAGE",
  "RELAY_USE_LOCAL_AGENT_HOME",
  "RELAY_WEB_UI_DIST_DIR",
]);

const AGENT_SUBPROCESS_ENV_DENY_PREFIXES = [
  "RELAY_ADMIN_",
  "RELAY_AUTH_",
  "RELAY_BACKEND_",
  "RELAY_CHAT_",
  "RELAY_DAEMON_",
  "RELAY_SUPERVISOR_",
  "RELAY_TASK_SCHEDULER_",
];

function localAgentSubprocessEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (isDeniedAgentSubprocessEnv(key)) {
      delete env[key];
    }
  }
  // A local node runs agents as child processes of the daemon, so anything in
  // the daemon's own environment is inherited. Provider credentials must not
  // ride along: the caller layers the running agent's own keys back on top, and
  // inheriting the rest would hand every agent every provider's key — exactly
  // the leak the BoxLite guest avoids by never holding credentials at all.
  for (const key of allAgentCredentialEnvNames()) delete env[key];
  const home = agentHomePath();
  env.HOME = home;
  env.CODEX_HOME = join(home, ".codex");
  env.PI_CODING_AGENT_DIR = join(home, ".pi", "agent");
  env.KIMI_CODE_HOME = join(home, ".kimi-code");
  return env;
}

function isDeniedAgentSubprocessEnv(key: string): boolean {
  return AGENT_SUBPROCESS_ENV_DENY.has(key)
    || AGENT_SUBPROCESS_ENV_DENY_PREFIXES.some((prefix) => key.startsWith(prefix));
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

function positiveIntEnv(name: string): number | undefined {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
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
): boolean {
  return activeRuns.size < maxConcurrentRuns;
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
const SHUTDOWN_REGISTRATION_TIMEOUT_MS = 250;
const SHUTDOWN_TERMINAL_EVENT_TIMEOUT_MS = 500;
const SIGKILL_DELAY_MS = 5_000;
const DEFAULT_COMMAND_POLL_WAIT_MS = 25_000;
const MAX_COMMAND_POLL_WAIT_MS = 25_000;
const DEFAULT_LIVENESS_HEARTBEAT_MS = 5_000;
const MAX_COMMAND_LEASE_SECONDS = 60 * 60;
const DEFAULT_COMMAND_LEASE_SECONDS = 90;

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
  employeeId?: string;
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
    throw new DaemonHttpError(`POST ${url} failed: ${response.status} ${await response.text()}`, response.status);
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
  control: { signal?: AbortSignal; shouldStop?: () => boolean } = {},
): Promise<T> {
  let attempt = 0;
  while (true) {
    if (control.signal?.aborted || control.shouldStop?.()) throw new DaemonStoppedError();
    try {
      return await action();
    } catch (error) {
      if (control.signal?.aborted || control.shouldStop?.()) throw new DaemonStoppedError();
      if (error instanceof DaemonHttpError && error.status < 500) throw error;
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
    throw new DaemonHttpError(`POST ${url} failed: ${response.status} ${await response.text()}`, response.status);
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

const EVENT_POST_RETRY_INITIAL_DELAY_MS = 200;
const EVENT_POST_RETRY_MAX_DELAY_MS = 10_000;

async function postJsonWithRetry(
  fetchFn: typeof fetch,
  url: string,
  body: unknown,
  token: string,
  signal?: AbortSignal,
): Promise<void> {
  let attempt = 0;
  while (true) {
    if (signal?.aborted) throw new Error("Aborted before event post.");
    try {
      await postJson(fetchFn, url, body, token, signal);
      return;
    } catch (error) {
      if (error instanceof DaemonHttpError && error.status < 500) throw error;
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

export {
  ThreadWorkspaceManager,
  type ThreadWorkspace,
} from "./thread-workspace.js";
