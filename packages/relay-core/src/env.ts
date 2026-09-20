import { mkdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const currentFile = fileURLToPath(import.meta.url);
// packages/relay-core/dist/env.js -> packages/relay-core/dist -> relay-core -> packages -> repo root
export const REPO_ROOT = resolve(dirname(currentFile), "../../..");
export const RELAY_CORE_ROOT = resolve(dirname(currentFile), "..");
export const DEVBOX_IMAGE = "relay-devbox:v1";
export const OCI_LAYOUT_DIR = resolve(REPO_ROOT, ".oci/relay-devbox-v1");
export const DOCKERFILE = resolve(REPO_ROOT, "dockerfile");
const ORIGINAL_ENV_KEYS = new Set(Object.keys(process.env));
const DOT_ENV_VALUES = new Map<string, string>();

export const ANTHROPIC_ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_MODEL",
] as const;

export const OPENAI_ENV_KEYS = [
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_MODEL",
] as const;

export const DEFAULT_HOST_WORKSPACE = "~/projects/air-platform";
export const PI_NATIVE_BASE_URL_PROVIDERS = new Set<string>();

function loadDotEnv(path: string, options: { overrideLoaded?: boolean } = {}): void {
  if (!existsSync(path)) return;
  for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key] !== undefined && (!options.overrideLoaded || ORIGINAL_ENV_KEYS.has(key))) continue;
    let value = rawValue.trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
    DOT_ENV_VALUES.set(key, value);
  }
}

export function loadPackageEnv(packageName: string): void {
  const packageRoot = resolve(REPO_ROOT, "packages", packageName);
  loadDotEnv(resolve(packageRoot, ".env"), { overrideLoaded: true });
  loadDotEnv(resolve(packageRoot, ".env.local"), { overrideLoaded: true });
}

function expandUser(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  return path;
}

loadDotEnv(resolve(REPO_ROOT, "packages/.env"));
loadPackageEnv("relay-core");
if (process.env.RELAY_WORKSPACE) {
  loadDotEnv(resolve(expandUser(process.env.RELAY_WORKSPACE), ".env"));
}
loadDotEnv(resolve(process.cwd(), ".env"));

export function hostWorkspacePath(raw?: string | null): string {
  const selected = raw?.trim() || process.env.RELAY_WORKSPACE?.trim() || process.env.WORKSPACE?.trim() || DEFAULT_HOST_WORKSPACE;
  const path = resolve(expandUser(selected));
  mkdirSync(path, { recursive: true });
  return path;
}

export function hostWorkspaceOwner(path: string): [number, number] {
  const resolved = hostWorkspacePath(path);
  const stat = statSync(resolved);
  return [stat.uid, stat.gid];
}

export function openaiApiKey(): string | undefined {
  return process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY || process.env.LLM_API_KEY;
}

export function openaiBaseUrl(): string | undefined {
  return process.env.OPENAI_BASE_URL || process.env.LLM_BASE_URL;
}

export function openaiModel(): string | undefined {
  return process.env.OPENAI_MODEL || process.env.LLM_MODEL;
}

export function anthropicApiKey(): string | undefined {
  return process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY;
}

export function anthropicBaseUrl(): string | undefined {
  return process.env.ANTHROPIC_BASE_URL || process.env.CLAUDE_BASE_URL;
}

export function anthropicModel(): string | undefined {
  return process.env.ANTHROPIC_MODEL || process.env.CLAUDE_MODEL;
}

export function requireOpenaiApiKey(): string {
  const key = openaiApiKey();
  if (!key) {
    throw new Error(
      "OPENAI_API_KEY (or CODEX_API_KEY) is required for Codex. " +
        "Set it in packages/.env or a package-local .env file.",
    );
  }
  return key;
}

export function kimiApiKey(): string | undefined {
  return process.env.KIMI_MODEL_API_KEY || process.env.KIMI_API_KEY || process.env.MOONSHOT_API_KEY;
}

export function kimiBaseUrl(): string | undefined {
  return process.env.KIMI_MODEL_BASE_URL || process.env.KIMI_BASE_URL || process.env.MOONSHOT_BASE_URL;
}

export function kimiModel(): string | undefined {
  return process.env.KIMI_MODEL_NAME || process.env.KIMI_MODEL || process.env.MOONSHOT_MODEL;
}

export function piApiKey(provider = piProvider()): string | undefined {
  if (process.env.PI_API_KEY) return process.env.PI_API_KEY;
  if (provider === "anthropic") return anthropicApiKey() || openaiApiKey();
  return openaiApiKey() || anthropicApiKey();
}

export function piSourceBaseUrl(): string | undefined {
  return process.env.PI_BASE_URL || openaiBaseUrl();
}

export function piModel(): string | undefined {
  return process.env.PI_MODEL || openaiModel();
}

function minimaxPiProviderForBaseUrl(baseUrl: string | undefined): string | undefined {
  if (!baseUrl) return undefined;
  let hostname: string;
  try {
    hostname = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    hostname = baseUrl.toLowerCase();
  }
  if (hostname === "api.minimaxi.com" || hostname.endsWith(".minimaxi.com")) return "minimax-cn";
  if (hostname === "api.minimax.io" || hostname.endsWith(".minimax.io")) return "minimax";
  return undefined;
}

function minimaxAnthropicBaseUrl(baseUrl: string): string | undefined {
  const provider = minimaxPiProviderForBaseUrl(baseUrl);
  if (!provider) return undefined;
  try {
    const url = new URL(baseUrl);
    return `${url.protocol}//${url.hostname}${url.port ? `:${url.port}` : ""}/anthropic`;
  } catch {
    return undefined;
  }
}

export function piProvider(): string {
  if (process.env.PI_PROVIDER) return process.env.PI_PROVIDER;
  const baseUrl = piSourceBaseUrl();
  const minimaxProvider = minimaxPiProviderForBaseUrl(baseUrl);
  if (minimaxProvider) return minimaxProvider;
  if (baseUrl) return "openai";
  if (anthropicApiKey()) return "anthropic";
  if (openaiApiKey()) return "openai";
  return "anthropic";
}

export function piBaseUrl(): string | undefined {
  const provider = piProvider();
  if (PI_NATIVE_BASE_URL_PROVIDERS.has(provider)) return undefined;
  if (process.env.PI_BASE_URL) return process.env.PI_BASE_URL;
  const baseUrl = openaiBaseUrl();
  if (!baseUrl) return undefined;
  return minimaxAnthropicBaseUrl(baseUrl) ?? baseUrl;
}

export function piApi(): string {
  if (process.env.PI_API) return process.env.PI_API;
  if (["anthropic", "minimax", "minimax-cn"].includes(piProvider())) {
    return "anthropic-messages";
  }
  return "openai-completions";
}

export function requirePiConfig(): void {
  if (piBaseUrl() && !piModel()) {
    throw new Error(
      "PI_MODEL or OPENAI_MODEL is required for Pi when using an " +
        "OpenAI/Anthropic-compatible base URL.",
    );
  }
  if (!piApiKey()) {
    throw new Error(
      "Pi requires PI_API_KEY, OPENAI_API_KEY/CODEX_API_KEY, or ANTHROPIC_API_KEY.",
    );
  }
}

/** Exclude values Relay loaded from .env while retaining the user's launch environment. */
export function localRuntimeEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const [key, value] of DOT_ENV_VALUES) {
    if (env[key] === value) delete env[key];
  }
  return env;
}
