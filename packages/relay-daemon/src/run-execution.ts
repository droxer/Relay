import {
  DaemonHttpError,
  requestSignal,
  withBackendReconnect,
  postJsonResponse,
  postJsonWithRetry,
  isRejectedOutputBatch,
  eventPostRetryLogger,
} from './backend-transport.js';
import { retryAfterMs } from "./transport-retry.js";
import { durableWorkspaceLayout, requiredWorkspaceSubpath } from "./run-workspace.js";
import { responseErrorDetail, transportErrorDetail } from "./http-error-detail.js";
import { join, resolve, sep } from "node:path";
import type { DaemonNodeEvent, DaemonNodeRunCommand, AgentName, AgentState, CodexCollaborationEvent } from "relay-core";
import { diffGeneratedFiles, snapshotGeneratedFiles } from "./generated-files.js";
import { consumeRoundResult, readRoundResult } from "./round-result.js";
import { syncProjectContext } from "./project-context.js";
import { consumeProjectSetup } from "./project-setup.js";
import { consumeNextSteps } from "./next-steps.js";
import { validateHandoffWorkspace } from "./handoff-validation.js";
import { agentWorkspaceSubpath, ensureAgentWorkspaceDir } from "./agent-workspace.js";
import { getAgent, runAgentNode, initialAgentState, mergeAgentState, agentHomePath, relayApiUrl } from "relay-core";
import {
  DEFAULT_ARTIFACTS_DIR,
  THREAD_RECORDS_DIR,
  THREAD_RECORDS_DIRS,
  ThreadWorkspaceManager,
} from "./thread-workspace.js";
import { OutputEventBuffer, type BufferedOutput } from "./output-event-buffer.js";
import { persistTerminalEvent, hasPendingOutput } from "./terminal-outbox.js";
import { materializeImages } from "./image-attachments.js";
import { createRunMcpProxy, MANAGED_MCP_CONTEXT_ENV } from "./relay-mcp-managed.js";
import { startNativeMcpBridge } from "./relay-mcp-native.js";
import { createProjectManagerBridge, managerWorkspaceTool } from "./project-manager.js";
import { materializeSkills, runSkillDelivery } from "./agent-skills.js";
import { permissionPromptsApply, startPermissionBroker } from "./permission-broker.js";
import { permissionAdapterLaunch } from "./permission-adapters/index.js";
import type { DaemonLogFields, DaemonLogger, DaemonExecutionEnvironment, WorkspaceExecution } from './index.js';
import { commandLogFields, commandLeaseEventFields, runCancelledEvent } from './run-events.js';
const DEFAULT_OUTPUT_DRAIN_TIMEOUT_MS = 250;

export async function executeCommand(
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
  settings: { outputBacklogBytes?: number; outputDrainTimeoutMs?: number } = {},
): Promise<DaemonNodeEvent> {
  const eventUrl = relayApiUrl(backendUrl, `/daemon-nodes/${encodeURIComponent(sandboxId)}/events`);
  const state = { ...(command.state ?? initialAgentState(command.taskGoal)), workspace_scope: command.workspaceScope, round_result_run_id: command.runId };
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
  // Records follow the handoff path the backend named: an older one still
  // names `.threads/` or `threads/`, and moving its records away would hide them.
  const recordsDir = THREAD_RECORDS_DIRS.find((dir) => state.progress_file?.startsWith(`${dir}/`))
    ?? THREAD_RECORDS_DIR;
  // Once a backend names `.relay/threads/`, every task workspace's older
  // records move there, once per process: an automation run's thread never
  // runs again, so its own run would never move them.
  if (recordsDir === THREAD_RECORDS_DIR && !threadWorkspaces.taskRecordsMigrated) {
    try {
      const moved = threadWorkspaces.migrateTaskRecords((workspace, error) => {
        logger.warn("thread records migration skipped a workspace", { sandboxId, workspace, error: error.message });
      });
      if (moved > 0) logger.info("thread records moved into .relay/threads", { sandboxId, threads: moved });
    } catch (error) {
      logger.warn("thread records migration failed", { sandboxId, error: (error as Error).message });
    }
  }
  const recordsId = threadWorkspaces.ensureRecords(threadWorkspace, artifactsDir, recordsDir, state.progress_file);
  if (artifactsDir === null) {
    delete state.artifacts_dir;
    state.deliverables_in_workspace = true;
  } else {
    state.artifacts_dir = artifactsDir;
    delete state.deliverables_in_workspace;
  }
  if (state.progress_file === `${recordsDir}/${command.sessionId}/HANDOFF.md`) {
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
  const managerToolAbort = new AbortController();
  let managerBridge: ReturnType<typeof createProjectManagerBridge> | undefined;
  let nativeMcpBridge: Awaited<ReturnType<typeof startNativeMcpBridge>> | undefined;
  try {
    // Work tools are restricted to this run's Computer or Project. Authority is checked by
    // the backend against the command identity and the requested resource.
    const projectScope = state.project_manager ?? state.project_reader;
    const invokeManager = createRunMcpProxy({backendUrl,sandboxId,nodeToken:token,
      commandId:command.id,leaseId:command.leaseId,projectId:projectScope?.projectId,fetchFn,
      signal:AbortSignal.any([managerToolAbort.signal,...(signal?[signal]:[])])});
    managerBridge = createProjectManagerBridge(threadWorkspace.hostPath, async (tool, args) => {
      const workspaceTool = ["files", "file", "search"].includes(tool);
      const result = await invokeManager(workspaceTool ? "workspace" : tool,args);
      return workspaceTool ? managerWorkspaceTool(threadWorkspace.hostPath, tool, args) : result;
    });
    if (invokeManager && environment.sandboxMode === "none") nativeMcpBridge = await startNativeMcpBridge(invokeManager);
    if (managerBridge && state.project_manager) state.project_manager = { ...state.project_manager, toolCommand: managerBridge.toolCommand };
    else if (managerBridge && state.project_reader) state.project_reader = { ...state.project_reader, toolCommand: managerBridge.toolCommand };
    state.relay_mcp = { toolCommand: managerBridge.toolCommand };
    return await runInWorkspace(execution);
  } finally {
    managerToolAbort.abort();
    try {
      try { await nativeMcpBridge?.dispose(); }
      finally { await managerBridge?.dispose(); }
    }
    finally { execution.release(); }
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
      const message = transportErrorDetail(error);
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
    const materialized = await materializeSkills({
      bundle: command.skills,
      agentId: command.logicalAgentId ?? `${command.agent}:${command.sessionId}`,
      delivery: runSkillDelivery(command.agent, environment.sandboxMode),
      agentHome: executionAgentHome,
      cacheDir: join(executionAgentHome, ".relay", "managed-skills"),
      execStream: execution.execStream,
      signal,
      fetchBlob: async (sha) => {
        const url = relayApiUrl(
          backendUrl,
          `/daemon-nodes/${encodeURIComponent(sandboxId)}/skill-blobs/${sha}?commandId=${encodeURIComponent(command.id)}`,
        );
        return withBackendReconnect(async () => {
          const response = await fetchFn(url, { headers: { Authorization: `Bearer ${token}` }, signal: requestSignal(signal) });
          if (!response.ok) throw new DaemonHttpError(
            `Skill blob unavailable (${response.status}): ${await responseErrorDetail(response)}`, response.status, retryAfterMs(response.headers.get("Retry-After")));
          return Buffer.from(await response.arrayBuffer());
        }, logger, { sandboxId, what: "skill blob download" }, { signal });
      },
    });
    let outputSequence = 0;
    let outputPostFailure: Error | undefined;
    // Batches the backend refused outright. A refusal is about the batch, not
    // the run, so the run keeps its exit status and is only flagged as gappy.
    let outputBatchesRejected = 0;
    const maxOutputBacklogBytes = settings.outputBacklogBytes ?? 16_777_216;
    const outputPostQueue: Array<{ post: () => Promise<void>; fields: DaemonLogFields; bytes: number }> = [];
    let outputPostHead = 0;
    let outputPostBacklogBytes = 0;
    let outputPostDrain: Promise<void> | undefined;
    // Output posts get their own abort so a finished run can stop waiting on
    // a backend that keeps failing them without cancelling the run itself.
    const outputAbort = new AbortController();
    const outputSignal = signal ? AbortSignal.any([signal, outputAbort.signal]) : outputAbort.signal;
    const outputDrainTimeoutMs = settings.outputDrainTimeoutMs ?? DEFAULT_OUTPUT_DRAIN_TIMEOUT_MS;
    // Set once the run stopped waiting for its output: what was not delivered
    // stays durable in the outbox and is replayed late, never dropped here.
    let outputDeliveryDeferred = false;
    const drainOutputPosts = async (): Promise<void> => {
      while (outputPostHead < outputPostQueue.length && !outputPostFailure && !outputDeliveryDeferred) {
        const item = outputPostQueue[outputPostHead++];
        try {
          await item.post();
        } catch (error) {
          if (outputDeliveryDeferred || outputSignal.aborted) {
            outputDeliveryDeferred = true;
            // Abandoned by the drain deadline; the outbox still holds it.
          } else if (isRejectedOutputBatch(error)) {
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
        // Batched delivery can finish this local post after durable capture,
        // before the backend accepts it. Keep coalescing until that backlog
        // clears; size and maximum-delay flushes still bound buffered output.
        if (outputPostHead >= outputPostQueue.length && !outputPostFailure
          && !hasPendingOutput(fetchFn, command.id)) outputBuffer.resume();
      }
      outputPostQueue.length = 0;
      outputPostHead = 0;
    };
    const startOutputDrain = (): void => {
      if (outputPostDrain || outputPostFailure || outputDeliveryDeferred || outputPostQueue.length === 0) return;
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
      if (outputPostFailure || outputDeliveryDeferred) return;
      if (outputPostBacklogBytes + bytes > maxOutputBacklogBytes) {
        outputDeliveryDeferred = true;
        outputAbort.abort('Output delivery deferred to durable replay.');
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
    // A finished run must not wait forever on a backend that keeps failing
    // its output: the terminal event, not the transcript, releases the run.
    const settleOutputPosts = async (): Promise<void> => {
      if (!outputPostDrain) return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), outputDrainTimeoutMs);
      });
      const outcome = await Promise.race([waitForOutputPosts().then(() => "drained" as const), deadline]);
      clearTimeout(timer);
      if (outcome === "drained") return;
      outputDeliveryDeferred = true;
      logger.warn("output delivery stalled; reporting the run's outcome and leaving undelivered output for replay", {
        ...commandLogFields(sandboxId, command),
        pendingPosts: outputPostQueue.length - outputPostHead + 1,
        timeoutMs: outputDrainTimeoutMs,
      });
      outputAbort.abort();
      await waitForOutputPosts();
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
      try { void persistTerminalEvent(fetchFn, event).catch(error => { outputPostFailure = error instanceof Error ? error : new Error(String(error)); }); } catch (error) {
        outputPostFailure = error instanceof Error ? error : new Error(String(error));
        return;
      }
      enqueueOutputPost(
        () => postJsonWithRetry(fetchFn, eventUrl, event, token, outputSignal, eventPostRetryLogger(logger, {
          ...commandLogFields(sandboxId, command),
          eventType: event.type,
          sequence: entries[0]?.sequence,
        })),
        { agent, sequence: entries[0]?.sequence },
        entries.reduce((total, entry) => total + Buffer.byteLength(entry.text), 0),
      );
    };
    // Batches are posted one at a time. While one is in flight the buffer keeps
    // collecting, so a slow backend gets fewer, larger posts instead of a queue
    // that grows by one post (and one durable record) every latency window.
    const outputBuffer = new OutputEventBuffer(
      (entries) => emitOutputBatch(command.agent, entries),
      { isBusy: () => !!outputPostDrain || outputDeliveryDeferred || hasPendingOutput(fetchFn, command.id) },
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
        try { void persistTerminalEvent(fetchFn, event).catch(error => { outputPostFailure = error instanceof Error ? error : new Error(String(error)); }); } catch (error) {
          outputPostFailure = error instanceof Error ? error : new Error(String(error));
          return;
        }
        enqueueOutputPost(
          () => postJsonWithRetry(fetchFn, eventUrl, event, token, outputSignal, eventPostRetryLogger(logger, {
            ...commandLogFields(sandboxId, command),
            eventType: event.type,
            sequence,
          })),
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
    const scanOptions = { ownAgentHomeSubdir: agentHomeSubdir, ownThreadId: recordsId };
    const options = {
      execStream: execution.execStream,
      runtimeEnv: { RELAY_WORKSPACE_SCOPE: JSON.stringify(command.workspaceScope ?? {}), ...(environment.sandboxMode === "none" ? {[MANAGED_MCP_CONTEXT_ENV]: JSON.stringify(managerBridge
        ? {backendUrl,projectId:(state.project_manager ?? state.project_reader)?.projectId,native:nativeMcpBridge?.address,bridgePath:join(threadWorkspace.hostPath,managerBridge.toolPath)}
        : {disabled:true})} : {}) },
      eventSink,
      runId: command.runId,
      agent: command.agent,
      signal,
      workspacePath: threadWorkspace.executionPath,
      // A no-op sink keeps rendered agent text off the daemon's own stdout and
      // stderr; live output still flows through eventSink to the backend and the
      // text run log. Supervisors set this so their logs stay lifecycle-only.
      ...(echoAgentOutput ? {} : { sink: () => undefined }),
    };
    const skillState = command.skills === undefined
      ? state
      : { ...state, skill_paths: materialized.skillPaths, skill_env: materialized.env };
    let runState = agentHomeSubdir
      ? { ...skillState, agent_home_subdir: agentHomeSubdir }
      : skillState;
    if (command.connections?.length) {
      if (!command.leaseId) throw new Error("Connection tools require an explicit command lease");
      // This endpoint only seals run-bound claims, so retrying a lost response
      // cannot execute a provider action. Include body decoding in the retry:
      // receiving headers does not mean the credential arrived intact.
      const credential = await withBackendReconnect(
        () => postJsonResponse<{ token?: unknown }>(fetchFn, relayApiUrl(backendUrl,
          `/daemon-nodes/${encodeURIComponent(sandboxId)}/commands/${encodeURIComponent(command.id)}/connections`),
        { leaseId: command.leaseId }, token, signal),
        logger, { sandboxId, what: "connection access" }, { signal },
      );
      if (typeof credential.token !== "string") throw new Error("Invalid connection access response");
      runState = { ...runState, connection_tools: {
        url: relayApiUrl(backendUrl, "/connection-tools"), token: credential.token,
      } };
    }
    // Snapshot document-type workspace files so a successful run can report
    // exactly what it created or changed (see generated-files.ts).
    const workspaceSnapshot = await snapshotGeneratedFiles(threadWorkspace.hostPath, scanOptions);
    let patch;
    let imageInput: Awaited<ReturnType<typeof materializeImages>> | undefined;
    try {
      imageInput = await materializeImages({
        attachments: command.attachments ?? [],
        hostPath: threadWorkspace.hostPath,
        executionPath: threadWorkspace.executionPath,
        fetchImage: (id) => fetchFn(relayApiUrl(backendUrl,
          `/daemon-nodes/${encodeURIComponent(sandboxId)}/attachments/${encodeURIComponent(id)}?commandId=${encodeURIComponent(command.id)}`),
          { headers: { Authorization: `Bearer ${token}` }, signal: requestSignal(signal) }),
      });
      if (imageInput.images.length) runState = { ...runState, input_images: imageInput.images };
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
      execution.forgetAgentReady?.(command.agent);
      consumeRoundResult(threadWorkspace.hostPath);
      consumeNextSteps(threadWorkspace.hostPath);
      consumeProjectSetup(threadWorkspace.hostPath, state.project_setup?.file);
      throw error;
    } finally {
      try { imageInput?.cleanup(); } catch (error) {
        logger.warn("Could not remove temporary image inputs", { ...commandLogFields(sandboxId, command), error: transportErrorDetail(error) });
      }
      outputBuffer.close();
      await settleOutputPosts();
    }
    const next = mergeAgentState(state, patch);
    // A failed exit may mean the runtime itself stopped working (signed out,
    // provider down); its next run checks before trusting the cached answer.
    if (next.last_exit_code !== 0) execution.forgetAgentReady?.(command.agent);
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
    // Only a clean finish offers its person a next step.
    const nextSteps = consumeNextSteps(threadWorkspace.hostPath);
    if (signal?.aborted) {
      logger.info("run cancelled", {
        ...commandLogFields(sandboxId, command),
        exitCode: next.last_exit_code,
      });
      return runCancelledEvent(command, outputPostFailure ? `Capture incomplete: ${outputPostFailure.message}` : signal.reason, agentLog, next.token_usage, next.runtime_session_id);
    }
    // Output delivery can fail after the agent process has successfully written
    // its deliverables. Preserve those files on the terminal failure event so
    // the backend can still index them for the thread Space.
    const generatedFiles = next.last_exit_code === 0
      ? await diffGeneratedFiles(threadWorkspace.hostPath, workspaceSnapshot, scanOptions)
      : [];
    if (outputPostFailure) {
      logger.error("run failed", { ...commandLogFields(sandboxId, command), error: `Daemon lost agent output: ${outputPostFailure.message}` });
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
      ...(nextSteps.length > 0 && next.last_exit_code === 0 ? { nextSteps } : {}),
      ...(outputBatchesRejected > 0 || outputDeliveryDeferred || hasPendingOutput(fetchFn, command.id) ? { outputTruncated: true } : {}),
      ...(next.runtime_session_id ? { runtimeSessionId: next.runtime_session_id } : {}),
      ...(projectSetup && state.project_setup ? { projectSetup } : {}),
    } satisfies DaemonNodeEvent;
  }
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
