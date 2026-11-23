import { commandExecution } from "./command-execution.js";
import { extractRuntimeSessionId, RuntimeSessionStream } from "./runtime-session.js";
import { getAgent } from "./agents.js";
import { JsonLineRenderer, StderrLineRenderer } from "./renderers.js";
import { parseJsonObject } from "./shell.js";
import {
  agentCredentialEnv,
  agentWorkspacePath,
} from "./guest.js";
import {
  withFailure,
  type AgentName,
  type AgentRunOptions,
  type AgentState,
} from "./state.js";
import { extractTokenUsageFromJsonl } from "./token-usage.js";
import { CodexCollaborationStream } from "./codex-collaboration.js";
import { truncateAgentTranscript } from "./transcript.js";

// The completed-run agent log is the fallback transcript for runs whose live
// output events are incomplete. A small tail cap drops the head of the stream,
// which renders as the reply's first characters going missing, so keep the
// budget generous and retain both ends; override with RELAY_AGENT_RESULT_LOG_LIMIT.
const DEFAULT_AGENT_TRANSCRIPT_LIMIT = 262_144;

/**
 * Character budget for retained agent transcript text, read at call time so tests
 * and operators can widen it. Every layer that truncates a transcript honors
 * this same number — the daemon's live stream capture as well as the log built
 * here — because a lower cap upstream would silently defeat raising it.
 */
export function agentTranscriptLimit(): number {
  return Number(process.env.RELAY_AGENT_RESULT_LOG_LIMIT) || DEFAULT_AGENT_TRANSCRIPT_LIMIT;
}

/**
 * Run one agent assignment. Command construction, rendering, and failure
 * accounting are all driven by the agent registry, so adding an agent never
 * requires a new node function — only a registry entry.
 */
export async function runAgentNode(
  agent: AgentName,
  state: AgentState,
  options: AgentRunOptions = {},
): Promise<Partial<AgentState>> {
  const def = getAgent(agent);
  const execute = requiredExecStream(options);
  const stderrRenderer = new StderrLineRenderer();
  const collaborationStream = agent === "codex" ? new CodexCollaborationStream() : undefined;
  const runId = options.runId;
  // Daemons pass a thread-specific directory. Direct callers retain the
  // environment-backed workspace for compatibility.
  const cwd = options.workspacePath ?? agentWorkspacePath();
  let startup: JsonLineRenderer | undefined;
  const run = async (runState: AgentState) => {
    const sessionStream = new RuntimeSessionStream(agent);
    const renderer = def.createRenderer();
    let sawStdout = false;
    // Keep an unconfirmed resume out of the Thread until it reaches its
    // session or becomes the final attempt. The command log still sees it.
    let pendingOutput: Array<{ stream: "stdout" | "stderr"; text: string }> | undefined =
      runState.resume_session_id && runId && options.eventSink ? [] : undefined;
    let remaining = agentTranscriptLimit();
    const publishOutput = (stream: "stdout" | "stderr", text: string): void => {
      if (runId) options.eventSink?.agentOutput(runId, agent, stream, text);
    };
    const flushPendingOutput = (): void => {
      for (const entry of pendingOutput ?? []) publishOutput(entry.stream, entry.text);
      pendingOutput = undefined;
    };
    const recordOutput = (stream: "stdout" | "stderr", chunk: string): void => {
      if (!pendingOutput) return publishOutput(stream, chunk);
      if (chunk && remaining > 0) {
        const text = chunk.slice(0, remaining);
        pendingOutput.push({ stream, text });
        remaining -= text.length;
      }
    };
    if (options.onRuntimeStarted) {
      const readyTypes = agent === "codex" ? ["turn.started"]
        : ["relay.runtime.started", "step_start", "text", "reasoning", "tool_use"];
      startup = new JsonLineRenderer(line => {
        if (startup && readyTypes.includes(String(parseJsonObject(line)?.type))) {
          startup = undefined;
          options.onRuntimeStarted?.();
        }
        return "";
      });
    }
    const invocation = commandExecution(def.buildCommand(runState, options.workspacePath, options.piOutputMode));
    let result = await execute(invocation.command, invocation.args, {
      cwd,
      stdoutRenderer: (chunk) => {
        sawStdout ||= Boolean(chunk);
        sessionStream.feed(chunk);
        if (pendingOutput && chunk.includes("\n") && sessionStream.finish()) flushPendingOutput();
        startup?.feed(chunk);
        recordOutput("stdout", chunk);
        if (runId && collaborationStream && options.eventSink?.agentCollaboration) {
          for (const event of collaborationStream.feed(chunk)) {
            options.eventSink.agentCollaboration(runId, agent, event);
          }
        }
        return renderer.feed(chunk);
      },
      stderrRenderer: (chunk) => {
        recordOutput("stderr", chunk);
        return stderrRenderer.feed(chunk);
      },
      sink: options.sink,
      signal: options.signal,
      // Output reaches the daemon through a pipe, where a Python CLI block-buffers
      // stdout and the transcript arrives in bursts; `stdbuf` (BoxLite only) does
      // not reach Python's own buffering, so ask for it on every computer.
      env: { PYTHONUNBUFFERED: "1", ...Object.fromEntries(agentCredentialEnv(agent)), ...options.runtimeEnv },
    });
    if (result.exit_code === 0 && !options.signal?.aborted && renderer.runFailure) {
      if (!sawStdout) renderer.feed(result.stdout);
      const failure = renderer.runFailure();
      if (failure) result = { ...result, exit_code: 1, error_message: result.error_message ?? failure };
    }
    return { result, runtimeSessionId: sessionStream.finish() ?? extractRuntimeSessionId(result.stdout, agent), flushPendingOutput };
  };
  let attempt = await run(state);
  // A resume that never reached its conversation (pruned, or recorded on
  // another computer) did no work, so the run starts fresh instead of failing.
  if (state.resume_session_id && attempt.result.exit_code !== 0 && !attempt.runtimeSessionId && !options.signal?.aborted) {
    const { resume_session_id: _dropped, ...fresh } = state;
    attempt = await run(fresh);
  }
  attempt.flushPendingOutput();
  const { result, runtimeSessionId } = attempt;
  const tokenUsage = extractTokenUsageFromJsonl(result.stdout, agent);

  return {
    agent_logs: [agentResultLog(def.label, result)],
    last_exit_code: result.exit_code,
    agent_failures: withFailure(state, agent, result.exit_code !== 0),
    token_usage: tokenUsage,
    ...(runtimeSessionId ? { runtime_session_id: runtimeSessionId } : {}),
  };
}

// Thin wrappers around the registry-driven node.
export function claudeNode(state: AgentState, options: AgentRunOptions = {}): Promise<Partial<AgentState>> {
  return runAgentNode("claude", state, options);
}

export function piNode(state: AgentState, options: AgentRunOptions = {}): Promise<Partial<AgentState>> {
  return runAgentNode("pi", state, options);
}

export function codexNode(state: AgentState, options: AgentRunOptions = {}): Promise<Partial<AgentState>> {
  return runAgentNode("codex", state, options);
}

function requiredExecStream(options: AgentRunOptions) {
  if (!options.execStream) {
    throw new Error("Agent node execution requires an execStream implementation.");
  }
  return options.execStream;
}

function agentResultLog(label: string, result: { exit_code: number; stdout: string; stderr: string; error_message?: string }, limit = agentTranscriptLimit()): string {
  const parts = [`[${label} Exit ${result.exit_code}]`];
  if (result.error_message) parts.push(`Error: ${result.error_message}`);
  if (result.stderr.trim()) parts.push(`stderr:\n${truncateAgentTranscript(result.stderr, limit)}`);
  if (result.stdout.trim()) parts.push(`stdout:\n${truncateAgentTranscript(result.stdout, limit)}`);
  return parts.join("\n");
}
