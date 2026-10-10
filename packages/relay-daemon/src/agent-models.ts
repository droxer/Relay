import { agentCredentialEnv, runAsAgent, type AgentName } from "relay-core";

// ── Agent model discovery ───────────────────────────────────────────────────
// Asks each runtime which models it offers, so the agent model picker lists
// what this node's CLI can actually run instead of a catalog baked into the
// web app. Every runtime answers from its own source:
//
//   claude  The provider's `/v1/models` gives versioned ids (claude-opus-5-5)
//           when the agent has a key or token; otherwise `claude --help`'s
//           aliases (fable, opus, …) and settings.json `model` stand in.
//           `.claude.json` adds the extra options the signed-in account
//           offers, and settings.json `availableModels` is an allowlist that
//           replaces all of it.
//   codex   `codex debug models`, or the CLI's own models_cache.json.
//           The catalog carries each model's full instructions (hundreds of
//           KB), so the sweep keeps only the slug/visibility/priority keys —
//           process output is tail-bounded and would lose the head.
//   pi      `pi --list-models` — only providers it can authenticate.
//   kimi    the `[models."<alias>"]` tables in its config.toml.
//
// Each sweep runs as the agent user with that agent's credentials, exactly
// like preflight, so it works the same in `boxlite` and `none` mode. Discovery
// is best-effort and never throws: a runtime that cannot be asked reports no
// models and the picker falls back to its default and a custom id.

type ExecLike = (
  cmd: string,
  args?: string[],
  options?: { signal?: AbortSignal; env?: Record<string, string> },
) => Promise<{ exit_code: number; stdout: string; stderr: string; error_message?: string }>;

/** Mirrors backend/relay/core/model_policy.py and web/src/lib/agentModels.ts. */
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@[\]+-]*$/;
const MODEL_ID_MAX_LENGTH = 128;
export const MAX_MODELS_PER_AGENT = 200;
const DEFAULT_MODEL_DISCOVERY_TIMEOUT_MS = 10_000;
const RECORD_SEPARATOR = "\t";
const PROVIDER_LIST_TIMEOUT_SECONDS = 8;

// Each source prints one `<source>\t<base64 payload>` record. The commands are
// constants; nothing caller-supplied reaches the shell.
const EMIT = `emit() { payload=$(base64 | tr -d '\\n'); if [ -n "$payload" ]; then printf '%s\\t%s\\n' "$1" "$payload"; fi; }`;
// Credentials reach curl as a header on stdin (`-H @-`), never in argv. With
// no key or token in the env, a local computer falls back to Claude Code's own
// saved login — its credentials file, or on macOS the keychain item it writes —
// so the employee's existing setup is enough. The token only ever lives in a
// shell variable; nothing from it is emitted.
const CLAUDE_SAVED_LOGIN_TOKEN = [
  "claude_login_token() {",
  '  creds=""; f="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/.credentials.json"',
  '  if [ -f "$f" ]; then creds=$(cat "$f")',
  '  elif [ "$(uname)" = Darwin ] && command -v security >/dev/null 2>&1; then creds=$(security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null); fi',
  `  printf '%s' "$creds" | grep -oE '"accessToken"[[:space:]]*:[[:space:]]*"[^"]+"' | head -n 1 | sed -E 's/.*"([^"]+)"$/\\1/'`,
  "}",
].join("\n");

const ANTHROPIC_MODELS_REQUEST = [
  CLAUDE_SAVED_LOGIN_TOKEN,
  'base="${ANTHROPIC_BASE_URL:-https://api.anthropic.com}"; base="${base%/}"',
  `models() { curl -fsS --max-time ${PROVIDER_LIST_TIMEOUT_SECONDS} -H @- -H 'anthropic-version: 2023-06-01' "$@" "$base/v1/models?limit=1000" 2>/dev/null | emit api; }`,
  "oauth() { printf 'authorization: Bearer %s\\n' \"$1\" | models -H 'anthropic-beta: oauth-2025-04-20'; }",
  "if command -v curl >/dev/null 2>&1; then",
  "  if [ -n \"${ANTHROPIC_API_KEY:-}\" ]; then printf 'x-api-key: %s\\n' \"$ANTHROPIC_API_KEY\" | models",
  "  elif [ -n \"${CLAUDE_CODE_OAUTH_TOKEN:-}\" ]; then oauth \"$CLAUDE_CODE_OAUTH_TOKEN\"",
  "  elif [ -n \"${ANTHROPIC_AUTH_TOKEN:-}\" ]; then printf 'authorization: Bearer %s\\n' \"$ANTHROPIC_AUTH_TOKEN\" | models",
  "  else token=$(claude_login_token); if [ -n \"$token\" ]; then oauth \"$token\"; fi",
  "  fi",
  "fi",
].join("\n");

const MODEL_SOURCES: Record<AgentName, readonly string[]> = {
  claude: [
    "if command -v claude >/dev/null 2>&1; then claude --help 2>/dev/null | emit help; fi",
    'f="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/settings.json"; if [ -f "$f" ]; then emit settings < "$f"; fi',
    // `.claude.json` also holds project history; keep only the cached options.
    'f="${CLAUDE_CONFIG_DIR:-$HOME}/.claude.json"; if [ -f "$f" ]; then tr -d \'\\n\' < "$f" | grep -oE \'"additionalModelOptionsCache":[[:space:]]*\\[([^][]|\\[[^][]*\\])*\\]\' | emit account; fi',
    ANTHROPIC_MODELS_REQUEST,
  ],
  codex: [
    'catalog=""; if command -v codex >/dev/null 2>&1; then catalog=$(codex debug models 2>/dev/null); fi',
    'f="${CODEX_HOME:-$HOME/.codex}/models_cache.json"; if [ -z "$catalog" ] && [ -f "$f" ]; then catalog=$(cat "$f"); fi',
    `printf '%s' "$catalog" | grep -oE '"(slug|visibility|priority)":[[:space:]]*("[^"]*"|-?[0-9]+)' | emit catalog`,
  ],
  // Pi prints its table on stderr.
  pi: ["if command -v pi >/dev/null 2>&1; then pi --list-models 2>&1 | emit list; fi"],
  kimi: ['f="${KIMI_CODE_HOME:-$HOME/.kimi-code}/config.toml"; if [ -f "$f" ]; then emit config < "$f"; fi'],
};

export function buildModelDiscoveryScript(agent: AgentName): string {
  return [EMIT, ...MODEL_SOURCES[agent], "exit 0"].join("\n");
}

/**
 * The last model list each provider returned, kept for the daemon's lifetime.
 * A local computer's saved login is short-lived and refreshed only when its
 * runtime runs, so a sweep can find it expired; reusing the last good list
 * keeps the picker on versioned ids instead of flipping back to aliases.
 */
export type ProviderListMemory = Map<AgentName, string>;

/**
 * Ask each of `agents` which models it offers. Agents that report nothing are
 * omitted. Best-effort: never throws.
 */
export async function discoverAgentModels(
  execStream: ExecLike,
  agents: readonly AgentName[],
  signal?: AbortSignal,
  timeoutMs = DEFAULT_MODEL_DISCOVERY_TIMEOUT_MS,
  providerLists: ProviderListMemory = new Map(),
): Promise<Partial<Record<AgentName, string[]>>> {
  if (signal?.aborted) return {};
  const entries = await Promise.all(agents.map(async (agent) => {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const discoverySignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    try {
      const result = await execStream("bash", ["-c", runAsAgent(buildModelDiscoveryScript(agent))], {
        signal: discoverySignal,
        env: Object.fromEntries(agentCredentialEnv(agent)),
      });
      if (result.exit_code !== 0) return [agent, []] as const;
      const fresh = providerListText(result.stdout);
      if (fresh) providerLists.set(agent, fresh);
      return [agent, parseAgentModels(agent, result.stdout, providerLists.get(agent))] as const;
    } catch {
      return [agent, []] as const;
    }
  }));
  return Object.fromEntries(entries.filter(([, models]) => models.length > 0));
}

/** The provider's model list in a sweep, when it returned one with any ids. */
export function providerListText(stdout: string): string | undefined {
  return decodeRecords(stdout)
    .filter((record) => record.source === "api" && anthropicApiModels(record.text).length > 0)
    .map((record) => record.text)
    .at(-1);
}

/**
 * Turn one agent's sweep output into its model ids, in the runtime's order.
 * `rememberedProviderList` stands in when this sweep could not reach the provider.
 */
export function parseAgentModels(agent: AgentName, stdout: string, rememberedProviderList?: string): string[] {
  const records = decodeRecords(stdout);
  const texts = (source: string) => records.filter((record) => record.source === source).map((record) => record.text);
  switch (agent) {
    case "claude":
      return validModels(claudeModels({
        helps: texts("help"),
        settingsFiles: texts("settings"),
        accounts: texts("account"),
        providerLists: providerListText(stdout)
          ? texts("api")
          : rememberedProviderList ? [rememberedProviderList] : [],
      }));
    case "codex":
      return validModels(texts("catalog").flatMap(codexCatalogModels));
    case "pi":
      return validModels(texts("list").flatMap(piListedModels));
    case "kimi":
      return validModels(texts("config").flatMap(kimiConfigModels));
  }
}

function decodeRecords(stdout: string): Array<{ source: string; text: string }> {
  const records: Array<{ source: string; text: string }> = [];
  for (const line of stdout.split("\n")) {
    const [source, payload] = line.trim().split(RECORD_SEPARATOR);
    if (!source || !payload) continue;
    records.push({ source, text: Buffer.from(payload, "base64").toString("utf8") });
  }
  return records;
}

function claudeModels(sources: {
  helps: string[];
  settingsFiles: string[];
  accounts: string[];
  providerLists: string[];
}): string[] {
  const settings = sources.settingsFiles.map(parseJsonObject);
  // `availableModels` is the runtime's own allowlist; when set it is the menu.
  const allowed = settings.flatMap((entry) => stringArray(entry?.availableModels));
  if (allowed.length > 0) return allowed;
  const accountModels = sources.accounts.flatMap(claudeAccountModels);
  // The provider's list names each model with its version (claude-opus-5-5);
  // the bare aliases only say "latest", so they are the fallback.
  const versioned = sources.providerLists.flatMap(anthropicApiModels);
  if (versioned.length > 0) return [...versioned, ...accountModels];
  const configured = settings.map((entry) => entry?.model).filter((model): model is string => typeof model === "string");
  return [...sources.helps.flatMap(claudeHelpAliases), ...configured, ...accountModels];
}

/** The `value`s of the model options Claude caches for the signed-in account. */
export function claudeAccountModels(text: string): string[] {
  const options = parseJsonObject(`{${text}}`)?.additionalModelOptionsCache;
  if (!Array.isArray(options)) return [];
  return options.flatMap((option: unknown) => {
    const value = option && typeof option === "object" ? (option as Record<string, unknown>).value : undefined;
    return typeof value === "string" ? [value] : [];
  });
}

/** The ids in a `/v1/models` page. */
export function anthropicApiModels(text: string): string[] {
  const data = parseJsonObject(text)?.data;
  if (!Array.isArray(data)) return [];
  return data.flatMap((model: unknown) => {
    const id = model && typeof model === "object" ? (model as Record<string, unknown>).id : undefined;
    return typeof id === "string" ? [id] : [];
  });
}

/** The quoted aliases in the `--model` option's description. */
export function claudeHelpAliases(help: string): string[] {
  const lines = help.split(/\r?\n/);
  const start = lines.findIndex((line) => /^\s*--model\b/.test(line));
  if (start < 0) return [];
  const description: string[] = [lines[start]];
  for (const line of lines.slice(start + 1)) {
    if (/^\s*-/.test(line)) break;
    description.push(line);
  }
  return [...description.join(" ").matchAll(/'([^'\s]+)'/g)].map((match) => match[1]);
}

/**
 * Codex's catalog, as the sweep's `"key":value` token stream: each `slug`
 * opens a model, and the first `visibility`/`priority` after it are that
 * model's own (nested objects come later in each entry). Hidden internal
 * models are not offered.
 */
export function codexCatalogModels(tokens: string): string[] {
  const models: Array<{ slug: string; visibility?: string; priority?: number }> = [];
  for (const line of tokens.split(/\r?\n/)) {
    const token = /^"(slug|visibility|priority)":\s*(?:"([^"]*)"|(-?\d+))$/.exec(line.trim());
    if (!token) continue;
    const [, key, text, number] = token;
    const current = models[models.length - 1];
    if (key === "slug" && text !== undefined) models.push({ slug: text });
    else if (key === "visibility" && current && current.visibility === undefined) current.visibility = text;
    else if (key === "priority" && current && current.priority === undefined && number !== undefined) current.priority = Number(number);
  }
  return models
    .filter((model) => model.visibility !== "hide")
    .map((model, index) => ({ slug: model.slug, rank: model.priority ?? Infinity, index }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((model) => model.slug);
}

/** Pi's `provider  model  context …` table, as the `provider/model` ids `--model` takes. */
export function piListedModels(text: string): string[] {
  const models: string[] = [];
  let inTable = false;
  for (const line of text.split(/\r?\n/)) {
    const [provider, model] = line.trim().split(/\s+/);
    if (!inTable) {
      inTable = provider === "provider" && model === "model";
      continue;
    }
    if (provider && model) models.push(`${provider}/${model}`);
  }
  return models;
}

/** Kimi's `--model` takes a config alias: `default_model` first, then each `[models.<alias>]`. */
export function kimiConfigModels(text: string): string[] {
  const models: string[] = [];
  let inRoot = true;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const section = /^\[models\.(?:"([^"]+)"|([A-Za-z0-9_-]+))\]$/.exec(line);
    if (section) models.push(section[1] ?? section[2]);
    if (line.startsWith("[")) inRoot = false;
    const fallback = inRoot ? /^default_model\s*=\s*"([^"]+)"/.exec(line) : null;
    if (fallback) models.unshift(fallback[1]);
  }
  return models;
}

function validModels(models: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of models) {
    const model = raw.trim();
    if (!model || model.length > MODEL_ID_MAX_LENGTH || !MODEL_ID.test(model) || seen.has(model)) continue;
    seen.add(model);
    result.push(model);
    if (result.length === MAX_MODELS_PER_AGENT) break;
  }
  return result;
}

function parseJsonObject(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}
