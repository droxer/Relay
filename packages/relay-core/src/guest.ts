import { Buffer } from "node:buffer";

import {
  anthropicApiKey,
  anthropicBaseUrl,
  anthropicModel,
  hostWorkspaceOwner,
  kimiApiKey,
  kimiBaseUrl,
  kimiModel,
  localRuntimeEnvironment,
  openaiBaseUrl,
  openaiApiKey,
  openaiModel,
  piApi,
  piApiKey,
  piBaseUrl,
  piModel,
  piProvider,
} from "./env.js";
import { AGENT_USER, GUEST_WORKSPACE, type AgentName } from "./state.js";
import { shellQuote } from "./shell.js";

export const GUEST_AGENT_SYNC_SCRIPT = `
set -eu
uid="\${RELAY_HOST_UID:?}"
gid="\${RELAY_HOST_GID:?}"
ws="/workspace"

if ! getent group "$gid" >/dev/null 2>&1; then
  groupadd -g "$gid" relay-host
fi

if id -u agent >/dev/null 2>&1; then
  usermod -o -u "$uid" -g "$gid" agent
else
  useradd -o -u "$uid" -g "$gid" -d /home/agent -s /bin/bash -m agent
fi

chown -R agent:agent /home/agent
chown -R agent:agent "$ws"
find "$ws" -type d -exec chmod u+rwx {} +
find "$ws" -type f -exec chmod u+rw {} +
`;

export let sessionGuestEnv: Array<[string, string]> = [];

export function setSessionGuestEnv(env: Array<[string, string]>): void {
  sessionGuestEnv = env;
}

/**
 * Per-agent credential resolvers. Each entry returns ONLY the secrets and
 * provider settings that agent needs at runtime, so a run is never handed
 * another provider's API key. The `Record<AgentName, …>` type forces an entry
 * when a new agent is added to the registry. Resolution reads `process.env`
 * (and the `.env`-derived fallbacks in env.ts) at call time so injection is
 * scoped to the single command invocation rather than the VM's lifetime.
 * Local execution uses native launch variables without .env values or aliases.
 */
const AGENT_CREDENTIAL_ENV_NAMES: Record<AgentName, readonly string[]> = {
  claude: ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "ANTHROPIC_MODEL"],
  codex: ["OPENAI_API_KEY", "CODEX_API_KEY", "OPENAI_BASE_URL", "OPENAI_MODEL"],
  pi: ["PI_API_KEY", "PI_BASE_URL", "PI_MODEL", "PI_PROVIDER", "PI_API"],
  kimi: [
    "KIMI_API_KEY", "KIMI_BASE_URL", "KIMI_MODEL",
    "MOONSHOT_API_KEY", "MOONSHOT_BASE_URL", "MOONSHOT_MODEL",
    "KIMI_MODEL_NAME", "KIMI_MODEL_API_KEY", "KIMI_MODEL_BASE_URL",
    "KIMI_MODEL_PROVIDER_TYPE", "KIMI_MODEL_MAX_CONTEXT_SIZE", "KIMI_MODEL_CAPABILITIES",
    "KIMI_MODEL_DISPLAY_NAME", "KIMI_MODEL_MAX_OUTPUT_SIZE", "KIMI_MODEL_REASONING_KEY",
    "KIMI_MODEL_THINKING_EFFORT", "KIMI_MODEL_ADAPTIVE_THINKING",
  ],
};

// Local CLIs consume their native environment and saved login, never Relay aliases.
const NATIVE_CREDENTIAL_ENV_NAMES: Record<AgentName, readonly string[]> = {
  claude: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_BASE_URL", "ANTHROPIC_MODEL"],
  codex: ["OPENAI_API_KEY", "CODEX_API_KEY", "OPENAI_BASE_URL"],
  pi: ["ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN", "OPENAI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "MINIMAX_API_KEY", "MINIMAX_CN_API_KEY", "KIMI_API_KEY"],
  kimi: AGENT_CREDENTIAL_ENV_NAMES.kimi.filter((key) => key.startsWith("KIMI_MODEL_") && key !== "KIMI_MODEL"),
};

export function isLocalAgentExecution(): boolean {
  return process.env.RELAY_RUN_AS_CURRENT_USER === "1";
}

const AGENT_CREDENTIAL_ENV: Record<AgentName, () => Array<[string, string]>> = {
  claude: () => {
    const env: Array<[string, string]> = [];
    pushEnv(env, "ANTHROPIC_API_KEY", anthropicApiKey());
    pushEnv(env, "ANTHROPIC_BASE_URL", anthropicBaseUrl());
    pushEnv(env, "ANTHROPIC_MODEL", anthropicModel());
    return env;
  },
  codex: () => {
    const env: Array<[string, string]> = [];
    const openaiKey = openaiApiKey();
    if (openaiKey) {
      env.push(["OPENAI_API_KEY", openaiKey]);
      env.push(["CODEX_API_KEY", openaiKey]);
    }
    pushEnv(env, "OPENAI_BASE_URL", openaiBaseUrl());
    pushEnv(env, "OPENAI_MODEL", openaiModel());
    return env;
  },
  pi: () => {
    const env: Array<[string, string]> = [];
    for (const key of AGENT_CREDENTIAL_ENV_NAMES.pi) {
      const value = process.env[key];
      if (value) env.push([key, value]);
    }
    if (!process.env.PI_API_KEY) {
      const value = piApiKey();
      if (value) env.push(["PI_API_KEY", value]);
    }
    return env;
  },
  kimi: () => {
    const env: Array<[string, string]> = [];
    for (const key of AGENT_CREDENTIAL_ENV_NAMES.kimi) {
      if (["KIMI_MODEL_NAME", "KIMI_MODEL_API_KEY", "KIMI_MODEL_BASE_URL"].includes(key)) continue;
      const value = process.env[key];
      if (value) env.push([key, value]);
    }
    if (kimiApiKey() || process.env.KIMI_MODEL_NAME) {
      pushEnv(env, "KIMI_MODEL_NAME", kimiModel());
      pushEnv(env, "KIMI_MODEL_API_KEY", kimiApiKey());
      pushEnv(env, "KIMI_MODEL_BASE_URL", kimiBaseUrl());
    }
    return env;
  },
};

/** The credential/provider env a single agent run needs — nothing else. */
export function agentCredentialEnv(agent: AgentName): Array<[string, string]> {
  if (isLocalAgentExecution()) {
    const env = localRuntimeEnvironment();
    return NATIVE_CREDENTIAL_ENV_NAMES[agent].flatMap((key) => env[key] ? [[key, env[key]] as [string, string]] : []);
  }
  return AGENT_CREDENTIAL_ENV[agent]();
}

/** The credential/provider keys {@link agentCredentialEnv} may return for an agent. */
export function agentCredentialEnvNames(agent: AgentName): readonly string[] {
  return [...new Set([...AGENT_CREDENTIAL_ENV_NAMES[agent], ...NATIVE_CREDENTIAL_ENV_NAMES[agent]])];
}

/**
 * Every provider key any agent can be handed. A BoxLite guest is scoped by
 * construction — the box is created without credentials, so only the executor
 * env reaches a run. A local node instead inherits the daemon's own
 * environment, so it must strip this set before adding the running agent's
 * keys back; otherwise one agent sees every provider's credentials.
 */
export function allAgentCredentialEnvNames(): string[] {
  return [...new Set([
    ...Object.values(AGENT_CREDENTIAL_ENV_NAMES).flat(),
    ...Object.values(NATIVE_CREDENTIAL_ENV_NAMES).flat(),
    "CLAUDE_API_KEY", "CLAUDE_BASE_URL", "CLAUDE_MODEL",
    "LLM_API_KEY", "LLM_BASE_URL", "LLM_MODEL",
  ])];
}

/**
 * Non-secret infrastructure env handed to the sandbox at creation. API keys are
 * deliberately excluded here: baking them into the box would make them resident
 * for the VM's whole lifetime and visible to every process and every agent.
 * Credentials are injected through the executor environment for one process.
 */
export function guestAgentEnv(hostWorkspace?: string | null): Array<[string, string]> {
  const env: Array<[string, string]> = [];
  if (hostWorkspace !== undefined && hostWorkspace !== null) {
    const [uid, gid] = hostWorkspaceOwner(hostWorkspace);
    env.push(["RELAY_HOST_UID", String(uid)]);
    env.push(["RELAY_HOST_GID", String(gid)]);
  }
  return env;
}

function envExports(env: Array<[string, string]>): string {
  return env
    .map(([key, value]) => `export ${key}=${shellQuote(value)}`)
    .join(" && ");
}

export function guestEnvExports(): string {
  return envExports(sessionGuestEnv);
}

export function guestCodexConfigToml(): string {
  const lines = [
    'sandbox_mode = "danger-full-access"',
  ];
  const model = openaiModel();
  const baseUrl = openaiBaseUrl();
  if (model) {
    lines.push(`model = ${JSON.stringify(model)}`);
  }
  if (baseUrl) {
    lines.push(
      'model_provider = "dashscope"',
      "",
      "[model_providers.dashscope]",
      'name = "DashScope"',
      `base_url = ${JSON.stringify(baseUrl)}`,
      'env_key = "OPENAI_API_KEY"',
      "requires_openai_auth = false",
    );
  }
  const multiAgent = codexMultiAgentEnabled();
  lines.push(
    "",
    "[features]",
    `multi_agent = ${multiAgent}`,
  );
  return `${lines.join("\n")}\n`;
}

export function guestCodexAuthJson(apiKey: string): string {
  return JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: apiKey });
}

export function guestPiAuthJson(): string {
  const auth: Record<string, { type: "api_key"; key: string }> = {};
  const piKey = piApiKey();
  if (piKey) auth[piProvider()] = { type: "api_key", key: piKey };
  return JSON.stringify(auth);
}

export function guestPiModelsJson(): string {
  const provider = piProvider();
  const model = piModel();
  const baseUrl = piBaseUrl();
  if (!baseUrl || !model) return JSON.stringify({ providers: {} });
  const providerConfig: Record<string, unknown> = {
    name: `${provider} compatible`,
    baseUrl,
    apiKey: "$PI_API_KEY",
    api: piApi(),
    models: [
      {
        id: model,
        name: model,
        reasoning: false,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 4096,
      },
    ],
  };
  if (piApi() === "openai-completions") {
    providerConfig.authHeader = true;
    providerConfig.compat = {
      supportsDeveloperRole: false,
      supportsStore: false,
      supportsUsageInStreaming: false,
      maxTokensField: "max_tokens",
    };
  }
  return JSON.stringify({ providers: { [provider]: providerConfig } });
}

export function codexCliConfigOverrides(): string[] {
  if (isLocalAgentExecution()) return [];
  const multiAgent = codexMultiAgentEnabled();
  const argv = [
    "-c",
    `features.multi_agent=${multiAgent}`,
  ];
  const model = openaiModel();
  const baseUrl = openaiBaseUrl();
  if (model) argv.push("-c", `model=${JSON.stringify(model)}`);
  if (baseUrl) {
    argv.push(
      "-c",
      'model_provider="dashscope"',
      "-c",
      'model_providers.dashscope.name="DashScope"',
      "-c",
      `model_providers.dashscope.base_url=${JSON.stringify(baseUrl)}`,
      "-c",
      'model_providers.dashscope.env_key="OPENAI_API_KEY"',
      "-c",
      "model_providers.dashscope.requires_openai_auth=false",
    );
  }
  return argv;
}

function codexMultiAgentEnabled(): boolean {
  const value = process.env.RELAY_CODEX_MULTI_AGENT?.trim().toLowerCase();
  return value !== "0" && value !== "false" && value !== "off";
}

function pushEnv(env: Array<[string, string]>, key: string, value: string | undefined): void {
  if (value) env.push([key, value]);
}

/**
 * Wrap a command so it runs as the guest `agent` user with the right HOME and
 * working directory. Provider credentials are deliberately absent from this
 * string so they cannot appear in argv, logs, or process listings.
 */
export function runAsAgent(command: string, workspacePath?: string): string {
  const workspace = workspacePath ?? agentWorkspacePath();
  const home = agentHomePath();
  const infrastructureExports = guestEnvExports();
  if (process.env.RELAY_RUN_AS_CURRENT_USER === "1") {
    return [
      `export HOME=${shellQuote(home)}`,
      infrastructureExports,
      `cd ${shellQuote(workspace)}`,
      command,
    ].filter(Boolean).join(" && ");
  }
  const parts = [
    "export HOME=/home/agent",
    "export CODEX_HOME=/home/agent/.codex",
    "export PI_CODING_AGENT_DIR=/home/agent/.pi/agent",
    "export KIMI_CODE_HOME=/home/agent/.kimi-code",
    "export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    "umask 002",
    infrastructureExports,
    `cd ${shellQuote(workspace)}`,
    command,
  ].filter(Boolean);
  return `su ${AGENT_USER} -s /bin/bash -c ${shellQuote(parts.join(" && "))}`;
}

export function agentWorkspacePath(): string {
  return process.env.RELAY_AGENT_WORKSPACE || GUEST_WORKSPACE;
}

export function agentHomePath(): string {
  return process.env.RELAY_AGENT_HOME || "/home/agent";
}

export function encodeBase64(value: string): string {
  return Buffer.from(value).toString("base64");
}
