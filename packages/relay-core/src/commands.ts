import { anthropicModel, openaiModel, piModel, piProvider } from "./env.js";
import { agentWorkspacePath, codexCliConfigOverrides, isLocalAgentExecution, runAsAgent } from "./guest.js";
import {
  claudeTaskPrompt,
  codexTaskPrompt,
  kimiTaskPrompt,
  piTaskPrompt,
} from "./prompts.js";
import { kimiApiKey, kimiModel, localRuntimeEnvironment } from "./env.js";
import { escapeRegExp, shellCommand, shellQuote } from "./shell.js";
import type { PermissionPromptAdapter } from "./agents.js";
import type { AgentState, PermissionPromptLaunch } from "./state.js";
import { isResumableSessionId } from "./runtime-session.js";

/** Only a well-formed id is ever placed on a command line. */
function resumeId(state: AgentState): string | undefined {
  return isResumableSessionId(state.resume_session_id) ? state.resume_session_id : undefined;
}

const RESUME_NOTE = "[Resumed run] Your previous run of this task was interrupted before it finished. "
  + "This conversation is that run. Check what you already completed and continue from there; do not start over.\n\n";

function withResumeNote(prompt: string, state: AgentState): string {
  return resumeId(state) ? RESUME_NOTE + prompt : prompt;
}

export function buildCodexCommand(state: AgentState, workspacePath?: string): string {
  const resume = resumeId(state);
  const prompt = withResumeNote(nativeSkillPrompt(codexTaskPrompt(state), state), state);
  const launch = permissionPromptLaunch(state, "codex-app-server");
  if (launch) {
    return runAsAgent(withSkillEnv(codexAppServerCommand(launch, { workspacePath, model: state.agent_model, resume, prompt }), state, "CODEX_HOME"), workspacePath);
  }
  const argv = [
    ...codexBaseArgv({ workspacePath, model: state.agent_model, resume }),
    ...(resume ? [resume] : []),
    prompt,
  ];
  return runAsAgent(withSkillEnv(shellCommand(argv), state, "CODEX_HOME"), workspacePath);
}

/**
 * `codex exec` never asks for approval, so a run that asks a person goes
 * through the Codex app-server adapter instead. It takes exec's options and
 * prints exec's `--json` stream, so rendering and parsing are unchanged.
 */
function codexAppServerCommand(
  launch: PermissionPromptLaunch,
  { workspacePath, model: pinned, resume, prompt }: { workspacePath?: string; model?: string; resume?: string; prompt: string },
): string {
  const argv = [
    launch.command,
    ...launch.args,
    ...codexCliConfigOverrides(pinned),
    "--cwd",
    workspacePath ?? agentWorkspacePath(),
  ];
  const model = runtimeModel(pinned, openaiModel);
  if (model) argv.push("--model", model);
  if (resume) argv.push("--resume", resume);
  argv.push("--", prompt);
  return [...envExports(launch.env), shellCommand(argv)].join(" && ");
}

function envExports(env: Record<string, string>): string[] {
  return Object.entries(env).map(([key, value]) => `export ${key}=${shellQuote(value)}`);
}

function codexBaseArgv({ workspacePath, model: pinned, resume }: { workspacePath?: string; model?: string; resume?: string } = {}): string[] {
  const workspace = workspacePath ?? agentWorkspacePath();
  const argv = [
    ...agentArgv("codex"),
    ...codexCliConfigOverrides(pinned),
    "-C",
    workspace,
    "exec",
    // `codex exec resume <id> <prompt>` takes the same options as exec.
    ...(resume ? ["resume"] : []),
    "--json",
    "--skip-git-repo-check",
    ...(trustedExecution() ? ["--dangerously-bypass-approvals-and-sandbox"] : []),
  ];
  const model = runtimeModel(pinned, openaiModel);
  if (model) argv.push("-m", model);
  return argv;
}

export function buildClaudeCommand(state: AgentState, workspacePath?: string): string {
  return buildClaudeInvocation(withResumeNote(nativeSkillPrompt(claudeTaskPrompt(state), state), state), state, workspacePath);
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
    ...(trustedExecution() ? ["--permission-mode", "bypassPermissions"] : []),
    // `--mcp-config` is variadic: the `--add-dir` after it ends its values, so
    // it can never swallow the prompt.
    ...claudePermissionPromptArgv(state),
    ...claudeRelayPathArgv(state, workspace),
    "--add-dir",
    workspace,
    "--verbose",
    "--output-format",
    "stream-json",
    "--include-partial-messages",
  ];
  const model = runtimeModel(state.agent_model, anthropicModel);
  if (model) argv.push("--model", model);
  const resume = resumeId(state);
  if (resume) argv.push("--resume", resume);
  argv.push(prompt);
  return runAsAgent(withSkillEnv(shellCommand(argv), state, "CLAUDE_CONFIG_DIR"), workspacePath);
}

/** Claude's full name for the `approve` tool of the MCP server named "relay". */
export const CLAUDE_PERMISSION_PROMPT_TOOL = "mcp__relay__approve";

/**
 * Headless Claude denies any tool that needs permission. Under a native local
 * policy the daemon can instead route those prompts to a person through a
 * stdio MCP server; isolated and trusted runs already bypass permissions.
 */
function claudePermissionPromptArgv(state: AgentState): string[] {
  const launch = permissionPromptLaunch(state, "claude-mcp");
  if (!launch) return [];
  const mcpConfig = {
    mcpServers: {
      relay: { type: "stdio", command: launch.command, args: launch.args, env: launch.env },
    },
  };
  return ["--permission-prompt-tool", CLAUDE_PERMISSION_PROMPT_TOOL, "--mcp-config", JSON.stringify(mcpConfig)];
}

/**
 * Files Relay itself hands a native local run: its assigned skills, which live
 * outside the workspace, and its round-result file. Headless Claude refuses a
 * read outside its directories and any write it cannot ask about, and a run
 * that cannot file its report leaves its person a stop with nothing to act on
 * — so these exact paths are allowed up front, and nothing else is.
 */
function claudeRelayPathArgv(state: AgentState, workspace: string): string[] {
  if (trustedExecution()) return [];
  const rules = [
    ...(state.skill_paths ?? []).map((path) => `Read(${claudeAbsoluteRulePath(path)}/**)`),
    ...(state.round_result_file
      ? [`Edit(${claudeAbsoluteRulePath(`${workspace.replace(/[\\/]+$/, "")}/${state.round_result_file}`)})`]
      : []),
    ...(state.next_steps_file
      ? [`Edit(${claudeAbsoluteRulePath(`${workspace.replace(/[\\/]+$/, "")}/${state.next_steps_file}`)})`]
      : []),
  ];
  // `--allowedTools` is variadic; the `--add-dir` after it ends its values.
  return rules.length ? ["--allowedTools", ...rules] : [];
}

/**
 * Claude's permission-rule form of an absolute path: `//` anchors the rule at
 * the filesystem root instead of the project. A Windows path keeps its drive
 * (`//C:/work/...`); a relative path has no such form, so it is refused rather
 * than silently anchored somewhere else.
 */
function claudeAbsoluteRulePath(path: string): string {
  const slashed = path.replace(/\\/g, "/");
  if (!/^(?:\/|[A-Za-z]:\/)/.test(slashed)) throw new Error(`Relay path for a Claude permission rule must be absolute: ${path}`);
  return `//${slashed.replace(/^\//, "")}`;
}

/** The run's adapter launch, when it is this builder's adapter and the run asks a person. */
function permissionPromptLaunch(state: AgentState, adapter: PermissionPromptAdapter): PermissionPromptLaunch | undefined {
  const launch = state.permission_prompt;
  if (!launch || launch.adapter !== adapter || trustedExecution()) return undefined;
  return launch;
}

export function buildPiCommand(state: AgentState, workspacePath?: string): string {
  return buildPiInvocation(piTaskPrompt(state), state.skill_paths, workspacePath, state.agent_model, permissionPromptLaunch(state, "pi-extension"));
}
/**
 * Pi has no permission system, so a run that asks a person loads the Pi
 * extension adapter (`--extension <script>`), whose `tool_call` hook puts
 * every command and edit in front of a person. The launch's script rides the
 * pi argv in every fallback command; its env is exported ahead of them and
 * the extension removes it from the process before any tool runs.
 */
function buildPiInvocation(
  prompt: string,
  skillPaths: string[] | undefined,
  workspacePath?: string,
  pinnedModel?: string,
  launch?: PermissionPromptLaunch,
): string {
  const argv = [...agentArgv("pi"), "--no-session"];
  if (launch) argv.push("--extension", launch.args[0]);
  if (skillPaths !== undefined) {
    argv.push("--no-skills");
    for (const path of skillPaths) argv.push("--skill", path);
  }
  // A provider-qualified pin ("openai/gpt-5") names its own provider; adding
  // the node's --provider would make Pi read it as a custom id of that one.
  const provider = isLocalAgentExecution() || isProviderQualified(pinnedModel) ? undefined : piProvider();
  if (provider) argv.push("--provider", provider);
  const model = runtimeModel(pinnedModel, piModel);
  if (model) argv.push("--model", model);
  const jsonCommand = shellCommand([...argv, "--mode", "json", prompt]);
  const streamingCommand = shellCommand([...argv, "-P", prompt]);
  const printCommand = shellCommand([...argv, "-p", prompt]);
  const supportsJsonMode =
    "pi --help 2>&1 | grep -Eq '(^|[[:space:]])--mode([=,[:space:]]|$)'";
  const supportsStreamingPrint =
    "pi --help 2>&1 | grep -Eq '(^|[[:space:]])(-P|--print-streaming)([=,[:space:]]|$)'";
  const invocation = `if ${supportsJsonMode}; then ${jsonCommand}; elif ${supportsStreamingPrint}; then ${streamingCommand}; else ${printCommand}; fi`;
  return runAsAgent(
    launch ? [...envExports(launch.env), invocation].join(" && ") : invocation,
    workspacePath,
  );
}

// Kimi (Moonshot AI) CLI. Flags verified against kimi-code 2.0; re-check
// `--auto`/`--output-format` against the installed version when bumping it.
export function buildKimiCommand(state: AgentState, workspacePath?: string): string {
  const launch = permissionPromptLaunch(state, "kimi-acp");
  if (launch) return buildKimiAcpInvocation(launch, nativeSkillPrompt(kimiTaskPrompt(state), state), workspacePath, state.agent_model);
  return buildKimiInvocation(kimiTaskPrompt(state), state.skill_paths, workspacePath, state.agent_model);
}
function buildKimiInvocation(
  prompt: string,
  skillPaths: string[] | undefined,
  workspacePath?: string,
  pinnedModel?: string,
): string {
  // `kimi -p` runs in Kimi's "Never Ask" mode whatever the flags: it never
  // asks a person, and only static deny rules stop a tool. --auto makes that
  // explicit where the run is isolated or trusted; a local native run that
  // asks a person goes through the ACP adapter instead.
  const argv = ["kimi", ...(trustedExecution() ? ["--auto"] : [])];
  for (const path of skillPaths ?? []) argv.push("--skills-dir", path);
  const { model, envModel } = kimiModelSelection(pinnedModel);
  if (model) argv.push("--model", model);
  // stream-json emits one JSON message object per stdout line (parsed by
  // KimiStreamRenderer) and keeps thinking + the resume notice off stdout.
  argv.push("--output-format", "stream-json", "--prompt", prompt);
  const command = shellCommand(argv);
  return runAsAgent(
    envModel ? `export KIMI_MODEL_NAME=${shellQuote(envModel)} && ${command}` : command,
    workspacePath,
  );
}

/**
 * `kimi -p` never asks, so a run that asks a person drives `kimi acp` through
 * the Kimi ACP adapter, which prints `kimi -p`'s stream-json. ACP takes no
 * --skills-dir, so assigned skills ride the prompt as for Claude and Codex.
 */
function buildKimiAcpInvocation(
  launch: PermissionPromptLaunch,
  prompt: string,
  workspacePath?: string,
  pinnedModel?: string,
): string {
  const argv = [launch.command, ...launch.args, "--cwd", workspacePath ?? agentWorkspacePath()];
  const { model, envModel } = kimiModelSelection(pinnedModel);
  if (model) argv.push("--model", model);
  argv.push("--prompt", prompt);
  const exports = [...envExports(launch.env), ...(envModel ? [`export KIMI_MODEL_NAME=${shellQuote(envModel)}`] : [])];
  return runAsAgent([...exports, shellCommand(argv)].join(" && "), workspacePath);
}

/**
 * With an API key (or KIMI_MODEL_NAME) the model is configured through the
 * KIMI_MODEL_* environment rather than --model, so a pinned model overrides
 * KIMI_MODEL_NAME there instead of adding a flag Kimi would not resolve.
 */
function kimiModelSelection(pinnedModel: string | undefined): { model?: string; envModel?: string } {
  const envConfigured = kimiModelFromEnvironment();
  const model = runtimeModel(pinnedModel, kimiModel);
  return {
    ...(model && !envConfigured ? { model } : {}),
    ...(pinnedModel && envConfigured ? { envModel: pinnedModel } : {}),
  };
}

/**
 * Whether the run's Kimi model comes from the KIMI_MODEL_* environment. It must
 * ask the environment the run actually receives: a local node passes only the
 * native KIMI_MODEL_* keys, so a KIMI_API_KEY in the daemon's own shell does not
 * configure the model there — trusting it would route the pin into an env var
 * Kimi ignores and silently run the user's default.
 */
function kimiModelFromEnvironment(): boolean {
  if (isLocalAgentExecution()) {
    const env = localRuntimeEnvironment();
    return Boolean(env.KIMI_MODEL_API_KEY || env.KIMI_MODEL_NAME);
  }
  return Boolean(kimiApiKey() || process.env.KIMI_MODEL_NAME);
}

function isProviderQualified(model: string | undefined): boolean {
  return Boolean(model?.includes("/"));
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
    // With no provider signed in, `pi --list-models` still exits 0 and says
    // "No models available"; surface that line as the failure detail.
    modelCheck = [
      `model_output=$(${shellCommand(listModelsArgv)} 2>&1) || { printf "%s\\n" "$model_output" >&2; exit 1; }`,
      `if printf "%s\\n" "$model_output" | grep -q '^No models available'; then printf "%s\\n" "$model_output" >&2; exit 1; fi`,
    ].join("; ");
  }
  // No `command -v pi`: a missing pi must fail `pi --version` with bash's 127
  // so the daemon reads it as not installed. The braces keep the model check's
  // `;` from running after an earlier step has failed.
  return runAsAgent(["node --version", "pi --version", `{ ${modelCheck}; }`].join(" && "));
}

/**
 * A model the agent pins wins everywhere, local execution included — the owner
 * chose it for this agent. Otherwise the daemon's env default applies, except
 * on a local node, which keeps the user's own CLI configuration.
 */
function runtimeModel(pinned: string | undefined, envDefault: () => string | undefined): string | undefined {
  if (pinned) return pinned;
  return isLocalAgentExecution() ? undefined : envDefault();
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

/** BoxLite is already isolated. Local execution preserves native policy by default. */
function trustedExecution(): boolean {
  if (!isLocalAgentExecution()) return true;
  const policy = process.env.RELAY_LOCAL_PERMISSION_POLICY ?? "native";
  if (policy !== "native" && policy !== "trusted") throw new Error(`Invalid local permission policy: ${policy}`);
  return policy === "trusted";
}
