import {
  buildClaudeCommand,
  buildCodexCommand,
  buildKimiCommand,
  buildPiCommand,
  buildPiPreflightCommand,
} from "./commands.js";
import { runAsAgent } from "./guest.js";
import {
  ClaudeStreamRenderer,
  CodexStreamRenderer,
  KimiStreamRenderer,
  PiStreamRenderer,
} from "./renderers.js";
import type { AgentName, AgentState } from "./state.js";

/** Minimal contract every stream renderer satisfies: feed a chunk, get display text. */
export interface StreamRenderer {
  feed(chunk: string): string;
}

export type SkillDelivery =
  | { kind: "config-dir"; envVar: string; subdir: string; skillsSubpath: string }
  | { kind: "skills-dir-flag"; flag: string }
  | { kind: "skill-path-flag"; flag: string; disableDiscoveryFlag: string };

export interface AgentDefinition {
  name: AgentName;
  /** Human-facing name used in readiness output and avatars. */
  displayName: string;
  /** Single-character avatar initial for the web UI. */
  initial: string;
  /** Consecutive-failure budget before the workflow halts retries for this agent. */
  maxFailures: number;
  buildCommand(state: AgentState, workspacePath?: string): string;
  createRenderer(): StreamRenderer;
  /** Label shown for the run artifact/log header. */
  label: string;
  /** Whether the daemon must provision guest auth files before this agent can run. */
  needsGuestAuth: boolean;
  skillDelivery: SkillDelivery;
  preflight: { label: string; command(): string };
}

export const AGENT_REGISTRY: Record<AgentName, AgentDefinition> = {
  claude: {
    name: "claude",
    displayName: "Claude Code",
    initial: "C",
    maxFailures: 3,
    buildCommand: buildClaudeCommand,
    createRenderer: () => new ClaudeStreamRenderer(),
    label: "Claude Code",
    needsGuestAuth: false,
    // Project skills remain additive to this isolated per-run config directory.
    skillDelivery: {
      kind: "config-dir",
      envVar: "CLAUDE_CONFIG_DIR",
      subdir: ".claude",
      skillsSubpath: "skills",
    },
    preflight: {
      label: "Claude Code auth",
      command: () => runAsAgent(
        'if [ -n "${ANTHROPIC_API_KEY:-}" ]; then claude --version; else claude auth status; fi',
      ),
    },
  },
  pi: {
    name: "pi",
    displayName: "Pi",
    initial: "π",
    maxFailures: 2,
    buildCommand: buildPiCommand,
    createRenderer: () => new PiStreamRenderer(),
    label: "Pi",
    needsGuestAuth: true,
    // Pi keeps explicit --skill paths when --no-skills disables discovery.
    skillDelivery: {
      kind: "skill-path-flag",
      flag: "--skill",
      disableDiscoveryFlag: "--no-skills",
    },
    preflight: { label: "Pi coding agent", command: buildPiPreflightCommand },
  },
  codex: {
    name: "codex",
    displayName: "Codex",
    initial: "X",
    maxFailures: 2,
    buildCommand: buildCodexCommand,
    createRenderer: () => new CodexStreamRenderer(),
    label: "Codex",
    needsGuestAuth: true,
    // CODEX_HOME/skills is isolated; project/admin skill discovery stays additive.
    skillDelivery: {
      kind: "config-dir",
      envVar: "CODEX_HOME",
      subdir: ".codex",
      skillsSubpath: "skills",
    },
    preflight: {
      label: "Codex auth",
      command: () => runAsAgent(
        'if [ -n "${OPENAI_API_KEY:-}${CODEX_API_KEY:-}" ]; then codex --version; else codex login status; fi',
      ),
    },
  },
  kimi: {
    name: "kimi",
    displayName: "Kimi",
    initial: "K",
    maxFailures: 2,
    buildCommand: buildKimiCommand,
    createRenderer: () => new KimiStreamRenderer(),
    label: "Kimi",
    needsGuestAuth: true,
    // Each path is a container whose direct children are skill directories.
    skillDelivery: { kind: "skills-dir-flag", flag: "--skills-dir" },
    preflight: { label: "Kimi", command: () => runAsAgent("kimi --version && kimi doctor && kimi provider list --json > /dev/null") },
  },
};

export const AGENT_NAMES = Object.keys(AGENT_REGISTRY) as AgentName[];

export function isAgentName(value: unknown): value is AgentName {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(AGENT_REGISTRY, value);
}

export function getAgent(name: AgentName): AgentDefinition {
  return AGENT_REGISTRY[name];
}

/** Comma-separated agent list for user-facing prompts, e.g. "claude, pi, codex, kimi". */
export function agentNameList(): string {
  return AGENT_NAMES.join(", ");
}
