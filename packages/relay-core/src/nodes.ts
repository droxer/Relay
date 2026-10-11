import { extractRuntimeSessionId } from "./runtime-session.js";
import { getAgent } from "./agents.js";
import { StderrLineRenderer } from "./renderers.js";
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

// The completed-run agent log is the fallback transcript for runs whose live
// output events are incomplete. A small tail cap drops the head of the stream,
// which renders as the reply's first characters going missing, so keep the
// budget generous; override with RELAY_AGENT_RESULT_LOG_LIMIT when needed.
const DEFAULT_AGENT_TRANSCRIPT_LIMIT = 262_144;

/**
 * Byte budget for retained agent transcript text, read at call time so tests
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
  const renderer = def.createRenderer();
  const stderrRenderer = new StderrLineRenderer();
  const collaborationStream = agent === "codex" ? new CodexCollaborationStream() : undefined;
  const runId = options.runId;
  // Daemons pass a thread-specific directory. Direct callers retain the
  // environment-backed workspace for compatibility.
  const cwd = options.workspacePath ?? agentWorkspacePath();
  const run = (runState: AgentState) => execute("bash", ["-c", def.buildCommand(runState, options.workspacePath)], {
    cwd,
    stdoutRenderer: (chunk) => {
      if (runId) options.eventSink?.agentOutput(runId, agent, "stdout", chunk);
      if (runId && collaborationStream && options.eventSink?.agentCollaboration) {
        for (const event of collaborationStream.feed(chunk)) {
          options.eventSink.agentCollaboration(runId, agent, event);
        }
      }
      return renderer.feed(chunk);
    },
    stderrRenderer: (chunk) => {
      if (runId) options.eventSink?.agentOutput(runId, agent, "stderr", chunk);
      return stderrRenderer.feed(chunk);
    },
    sink: options.sink,
    signal: options.signal,
    // Output reaches the daemon through a pipe, where a Python CLI block-buffers
    // stdout and the transcript arrives in bursts; `stdbuf` (BoxLite only) does
    // not reach Python's own buffering, so ask for it on every computer.
    env: { PYTHONUNBUFFERED: "1", ...Object.fromEntries(agentCredentialEnv(agent)) },
  });
  let result = await run(state);
  let runtimeSessionId = extractRuntimeSessionId(result.stdout, agent);
  // A resume that never reached its conversation (pruned, or recorded on
  // another computer) did no work, so the run starts fresh instead of failing.
  if (state.resume_session_id && result.exit_code !== 0 && !runtimeSessionId && !options.signal?.aborted) {
    const { resume_session_id: _dropped, ...fresh } = state;
    result = await run(fresh);
    runtimeSessionId = extractRuntimeSessionId(result.stdout, agent);
  }
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
  if (result.stderr.trim()) parts.push(`stderr:\n${result.stderr.slice(-limit)}`);
  if (result.stdout.trim()) parts.push(`stdout:\n${result.stdout.slice(-limit)}`);
  return parts.join("\n");
}
