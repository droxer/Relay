import { getAgent, type AgentName } from "relay-core";

/** The agent's CLI is absent; distinct from a CLI that is present but not signed in. */
export class AgentNotInstalledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentNotInstalledError";
  }
}

/** The agent's check did not finish in time: the CLI is present but hung. */
export class AgentUnresponsiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentUnresponsiveError";
  }
}

/** How long one readiness check may take before its runtime reads as unresponsive. */
export const AGENT_PREFLIGHT_TIMEOUT_MS = 60_000;

export function agentPreflightTimeoutMs(): number {
  const value = Number(process.env.RELAY_DAEMON_AGENT_PREFLIGHT_TIMEOUT_MS);
  return Number.isInteger(value) && value > 0 ? value : AGENT_PREFLIGHT_TIMEOUT_MS;
}

interface PreflightResult {
  exit_code: number;
  stdout?: string;
  stderr?: string;
  error_message?: string;
}

const COMMAND_NOT_FOUND_EXIT = 127;
// zsh puts the name last ("zsh: command not found: codex") and must be tried
// first, since its "zsh: command not found" prefix also fits the bash shape.
const COMMAND_NOT_FOUND_PATTERNS = [
  /command not found:\s+([\w.-]+)/,
  // bash: "codex: command not found"; sh/dash: "codex: not found".
  /([\w.-]+):\s+(?:command\s+)?not found/,
];

function missingCommand(detail: string): string | undefined {
  for (const pattern of COMMAND_NOT_FOUND_PATTERNS) {
    const match = pattern.exec(detail);
    if (match) return match[1];
  }
  return undefined;
}

/** Converts a failed preflight into the error a person can act on. */
export function agentPreflightError(agent: AgentName, result: PreflightResult): Error {
  const def = getAgent(agent);
  const detail = (result.stderr || result.stdout || result.error_message || "").trim();
  const command = missingCommand(detail);
  if (command || result.exit_code === COMMAND_NOT_FOUND_EXIT) {
    return new AgentNotInstalledError(
      `${def.displayName} is not installed on this computer${command ? ` (\`${command}\` was not found on PATH)` : ""}.`,
    );
  }
  return new Error(`${def.preflight.label} preflight failed.${detail ? ` ${detail}` : ""}`);
}

/**
 * Runs one readiness check under its own deadline. A check that outlives the
 * deadline is reported as unresponsive rather than left to hold up
 * registration; cancellation by the caller's signal is passed through as is.
 */
export async function runBoundedPreflight(
  agent: AgentName,
  signal: AbortSignal | undefined,
  run: (signal: AbortSignal) => Promise<PreflightResult>,
  timeoutMs: number = agentPreflightTimeoutMs(),
): Promise<void> {
  const deadline = AbortSignal.timeout(timeoutMs);
  const bounded = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const timedOut = (): boolean => deadline.aborted && !signal?.aborted;
  let result: PreflightResult;
  try {
    result = await run(bounded);
  } catch (error) {
    if (timedOut()) throw unresponsiveError(agent, timeoutMs);
    throw error;
  }
  if (timedOut()) throw unresponsiveError(agent, timeoutMs);
  if (result.exit_code !== 0) throw agentPreflightError(agent, result);
}

function unresponsiveError(agent: AgentName, timeoutMs: number): AgentUnresponsiveError {
  const def = getAgent(agent);
  return new AgentUnresponsiveError(
    `${def.preflight.label} check did not finish within ${Math.round(timeoutMs / 1000)}s; ${def.displayName} is not responding.`,
  );
}
