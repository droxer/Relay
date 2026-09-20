import { anthropicModel, openaiModel, piModel, piProvider } from "./env.js";
import { agentWorkspacePath, codexCliConfigOverrides, isLocalAgentExecution, runAsAgent } from "./guest.js";
import {
  claudeTaskPrompt,
  codexTaskPrompt,
  kimiTaskPrompt,
  piTaskPrompt,
} from "./prompts.js";
import { kimiApiKey, kimiModel } from "./env.js";
import { escapeRegExp, shellCommand, shellQuote } from "./shell.js";
import type { AgentState } from "./state.js";

export function buildCodexCommand(state: AgentState, workspacePath?: string): string {
  const argv = [...codexBaseArgv({ workspacePath }), nativeSkillPrompt(codexTaskPrompt(state), state)];
  return runAsAgent(withSkillEnv(shellCommand(argv), state, "CODEX_HOME"), workspacePath);
}

function codexBaseArgv({ workspacePath }: { workspacePath?: string } = {}): string[] {
  const workspace = workspacePath ?? agentWorkspacePath();
  const argv = [
    ...agentArgv("codex"),
    ...codexCliConfigOverrides(),
    "-C",
    workspace,
    "exec",
    "--json",
    "--skip-git-repo-check",
    "--dangerously-bypass-approvals-and-sandbox",
  ];
  const model = isLocalAgentExecution() ? undefined : openaiModel();
  if (model) argv.push("-m", model);
  return argv;
}

export function buildClaudeCommand(state: AgentState, workspacePath?: string): string {
  return buildClaudeInvocation(nativeSkillPrompt(claudeTaskPrompt(state), state), state, workspacePath);
}
function buildClaudeInvocation(
  prompt: string,
  state: AgentState,
  workspacePath?: string,
): string {
  const workspace = workspacePath ?? agentWorkspacePath();
  const argv = [
    ...agentArgv("claude"),
    "-p",
    "--permission-mode",
    "bypassPermissions",
    "--add-dir",
    workspace,
    "--verbose",
    "--output-format",
    "stream-json",
    "--include-partial-messages",
  ];
  const model = isLocalAgentExecution() ? undefined : anthropicModel();
  if (model) argv.push("--model", model);
  argv.push(prompt);
  return runAsAgent(withSkillEnv(shellCommand(argv), state, "CLAUDE_CONFIG_DIR"), workspacePath);
}

export function buildPiCommand(state: AgentState, workspacePath?: string): string {
  return buildPiInvocation(piTaskPrompt(state), state.skill_paths, workspacePath);
}
function buildPiInvocation(prompt: string, skillPaths: string[] | undefined, workspacePath?: string): string {
  const argv = [...agentArgv("pi"), "--no-session"];
  if (skillPaths !== undefined) {
    argv.push("--no-skills");
    for (const path of skillPaths) argv.push("--skill", path);
  }
  const provider = isLocalAgentExecution() ? undefined : piProvider();
  if (provider) argv.push("--provider", provider);
  const model = isLocalAgentExecution() ? undefined : piModel();
  if (model) argv.push("--model", model);
  const jsonCommand = shellCommand([...argv, "--mode", "json", prompt]);
  const streamingCommand = shellCommand([...argv, "-P", prompt]);
  const printCommand = shellCommand([...argv, "-p", prompt]);
  const supportsJsonMode =
    "pi --help 2>&1 | grep -Eq '(^|[[:space:]])--mode([=,[:space:]]|$)'";
  const supportsStreamingPrint =
    "pi --help 2>&1 | grep -Eq '(^|[[:space:]])(-P|--print-streaming)([=,[:space:]]|$)'";
  return runAsAgent(
    `if ${supportsJsonMode}; then ${jsonCommand}; elif ${supportsStreamingPrint}; then ${streamingCommand}; else ${printCommand}; fi`,
    workspacePath,
  );
}

// Kimi (Moonshot AI) CLI. Flags verified against kimi-code 0.39; re-check
// `--auto`/`--output-format` against the installed version when bumping it.
export function buildKimiCommand(state: AgentState, workspacePath?: string): string {
  return buildKimiInvocation(kimiTaskPrompt(state), state.skill_paths, workspacePath);
}
function buildKimiInvocation(prompt: string, skillPaths: string[] | undefined, workspacePath?: string): string {
  // Kimi asks before tool calls by default. The run is headless, so nothing can
  // answer and the agent would stall; --auto is its equivalent of Claude's
  // bypassPermissions and Codex's approval bypass.
  const argv = ["kimi", "--auto"];
  for (const path of skillPaths ?? []) argv.push("--skills-dir", path);
  const model = isLocalAgentExecution() ? undefined : kimiModel();
  if (model && !kimiApiKey() && !process.env.KIMI_MODEL_NAME) argv.push("--model", model);
  // stream-json emits one JSON message object per stdout line (parsed by
  // KimiStreamRenderer) and keeps thinking + the resume notice off stdout.
  argv.push("--output-format", "stream-json", "--prompt", prompt);
  return runAsAgent(shellCommand(argv), workspacePath);
}

function withSkillEnv(command: string, state: AgentState, allowedKey: string): string {
  if (isLocalAgentExecution()) return command;
  const value = state.skill_env?.[allowedKey];
  return value === undefined ? command : `export ${allowedKey}=${shellQuote(value)} && ${command}`;
}

export function buildPiPreflightCommand(): string {
  const listModelsArgv = ["pi", "--list-models"];
  const provider = isLocalAgentExecution() ? undefined : piProvider();
  const model = isLocalAgentExecution() ? undefined : piModel();
  let modelCheck: string;
  if (model && provider) {
    listModelsArgv.push(`${provider} ${model}`);
    const listModelsCommand = shellCommand(listModelsArgv);
    const modelRowPattern = shellQuote(
      `^${escapeRegExp(provider)}[[:space:]]+${escapeRegExp(model)}([[:space:]]|$)`,
    );
    modelCheck = [
      `model_output=$(${listModelsCommand} 2>&1)`,
      'printf "%s\\n" "$model_output"',
      `printf "%s\\n" "$model_output" | grep -E ${modelRowPattern}`,
    ].join("; ");
  } else {
    modelCheck = shellCommand(listModelsArgv);
  }
  return runAsAgent(["node --version", "command -v pi", "pi --version", modelCheck].join(" && "));
}

function agentArgv(agent: string): string[] {
  return isLocalAgentExecution() ? [agent] : ["stdbuf", "-oL", "-eL", agent];
}

/** Local skills are task context; the CLI keeps its own config and auth home. */
function nativeSkillPrompt(prompt: string, state: AgentState): string {
  if (!isLocalAgentExecution() || !state.skill_paths?.length) return prompt;
  const paths = state.skill_paths.map((path) => JSON.stringify(`${path}/SKILL.md`));
  return `${prompt}\n\n[Assigned skills]\nRead and follow these skill instructions before working:\n${paths.join("\n")}`;
}
