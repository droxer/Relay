import {
  buildClaudeCommand,
  buildCodexCommand,
  buildKimiCommand,
  buildOpenCodeCommand,
  buildPiCommand,
  buildPiPreflightCommand,
} from "./commands.js";
import { runAsAgent } from "./guest.js";
import {
  ClaudeStreamRenderer,
  CodexStreamRenderer,
  KimiStreamRenderer,
  OpenCodeStreamRenderer,
  PiStreamRenderer,
} from "./renderers.js";
import type { AgentName, AgentState } from "./state.js";

/** Minimal contract every stream renderer satisfies: feed a chunk, get display text. */
export interface StreamRenderer {
  feed(chunk: string): string;
}

export type SkillDelivery =
  | { kind: "prompt-paths" }
  | { kind: "config-dir"; envVar: string; subdir: string; skillsSubpath: string }
  | { kind: "skills-dir-flag"; flag: string }
  | { kind: "skill-path-flag"; flag: string; disableDiscoveryFlag: string };

/**
 * The translator between a runtime's own approval protocol and Relay's
 * permission broker. Claude mounts its adapter as an MCP server, Codex and
 * Kimi run theirs in place of their CLI, and Pi loads its adapter as an
 * extension (`--extension <script>`): the launch's script is handed to `pi`
 * rather than run by node.
 */
export type PermissionPromptAdapter = "claude-mcp" | "codex-app-server" | "kimi-acp" | "opencode-acp" | "pi-extension";

/** Whether a local, native-policy run of this runtime can ask a person before a tool use. */
export type PermissionPromptSupport = { kind: "none" } | { kind: "adapter"; adapter: PermissionPromptAdapter };

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
  /** How live permission prompts reach a person on a local, native-policy run. */
  permissionPrompts: PermissionPromptSupport;
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
    // Claude asks through its --permission-prompt-tool MCP hook.
    permissionPrompts: { kind: "adapter", adapter: "claude-mcp" },
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
    // Pi has no permission system of its own, so the extension gives it the
    // posture Claude's default has: every command and edit asks a person;
    // reads pass.
    permissionPrompts: { kind: "adapter", adapter: "pi-extension" },
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
    // `codex exec` never asks; approvals exist only over `codex app-server`.
    permissionPrompts: { kind: "adapter", adapter: "codex-app-server" },
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
    // Kimi asks over ACP `session/request_permission`.
    permissionPrompts: { kind: "adapter", adapter: "kimi-acp" },
    preflight: { label: "Kimi", command: () => runAsAgent("kimi --version && kimi doctor && kimi provider list --json > /dev/null") },
  },
  opencode: {
    name: "opencode",
    displayName: "OpenCode",
    initial: "O",
    maxFailures: 2,
    buildCommand: buildOpenCodeCommand,
    createRenderer: () => new OpenCodeStreamRenderer(),
    label: "OpenCode",
    // OpenCode keeps its login in its own data directory; the run reads it
    // from the native home, so no guest auth files are provisioned here.
    needsGuestAuth: false,
    skillDelivery: { kind: "prompt-paths" },
    // OpenCode asks through `opencode acp`'s session/request_permission. Its
    // `always` choice is never sent: the broker grants one approval at a time.
    permissionPrompts: { kind: "adapter", adapter: "opencode-acp" },
    preflight: { label: "OpenCode", command: () => runAsAgent("opencode --version && opencode auth list > /dev/null") },
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
