import { getAgent, type AgentName } from "relay-core";

/** The agent's CLI is absent; distinct from a CLI that is present but not signed in. */
export class AgentNotInstalledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentNotInstalledError";
  }
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
