import { anthropicModel, openaiModel, piModel, piProvider } from "./env.js";
import { agentWorkspacePath, codexCliConfigOverrides, runAsAgent } from "./guest.js";
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
  const argv = [...codexBaseArgv({ workspacePath }), codexTaskPrompt(state)];
  return runAsAgent(withSkillEnv(shellCommand(argv), state, "CODEX_HOME"), workspacePath);
}

function codexBaseArgv({ workspacePath }: { workspacePath?: string } = {}): string[] {
  const workspace = workspacePath ?? agentWorkspacePath();
  const argv = [
    "stdbuf",
    "-oL",
    "-eL",
    "codex",
    ...codexCliConfigOverrides(),
    "-C",
    workspace,
    "exec",
    "--json",
    "--skip-git-repo-check",
    "--dangerously-bypass-approvals-and-sandbox",
  ];
  const model = openaiModel();
  if (model) argv.push("-m", model);
  return argv;
}

export function buildClaudeCommand(state: AgentState, workspacePath?: string): string {
  return buildClaudeInvocation(claudeTaskPrompt(state), state, workspacePath);
}
function buildClaudeInvocation(
  prompt: string,
  state: AgentState,
  workspacePath?: string,
): string {
  const workspace = workspacePath ?? agentWorkspacePath();
  const argv = [
    "stdbuf",
    "-oL",
    "-eL",
    "claude",
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
  const model = anthropicModel();
  if (model) argv.push("--model", model);
  argv.push(prompt);
  return runAsAgent(withSkillEnv(shellCommand(argv), state, "CLAUDE_CONFIG_DIR"), workspacePath);
}

export function buildPiCommand(state: AgentState, workspacePath?: string): string {
  return buildPiInvocation(piTaskPrompt(state), state.skill_paths, workspacePath);
}
function buildPiInvocation(prompt: string, skillPaths: string[] | undefined, workspacePath?: string): string {
  const argv = ["stdbuf", "-oL", "-eL", "pi", "--no-session"];
  if (skillPaths !== undefined) {
    argv.push("--no-skills");
    for (const path of skillPaths) argv.push("--skill", path);
  }
  const provider = piProvider();
  if (provider) argv.push("--provider", provider);
  const model = piModel();
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
  const model = kimiModel();
  if (model && !kimiApiKey() && !process.env.KIMI_MODEL_NAME) argv.push("--model", model);
  // stream-json emits one JSON message object per stdout line (parsed by
  // KimiStreamRenderer) and keeps thinking + the resume notice off stdout.
  argv.push("--output-format", "stream-json", "--prompt", prompt);
  return runAsAgent(shellCommand(argv), workspacePath);
}

function withSkillEnv(command: string, state: AgentState, allowedKey: string): string {
  const value = state.skill_env?.[allowedKey];
  return value === undefined ? command : `export ${allowedKey}=${shellQuote(value)} && ${command}`;
}

export function buildPiPreflightCommand(): string {
  const listModelsArgv = ["pi", "--list-models"];
  const provider = piProvider();
  const model = piModel();
  let modelCheck: string;
  if (model) {
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
