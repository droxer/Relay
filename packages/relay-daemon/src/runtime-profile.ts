import { lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync, rmSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
import { AGENT_NAMES, agentCredentialEnvNames } from "relay-core";

// Deliberately omit arbitrary shell variables and Node's code-loading settings.
const SETTING_KEYS = new Set([
  "HOME", "PATH", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "PI_CODING_AGENT_DIR", "KIMI_CODE_HOME",
  "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS",
  "ANTHROPIC_BASE_URL", "ANTHROPIC_MODEL", "OPENAI_BASE_URL",
]);
const CREDENTIAL_KEYS = new Set(AGENT_NAMES.flatMap(agent => [...agentCredentialEnvNames(agent)]));
const ALLOWED_KEYS = new Set([...SETTING_KEYS, ...CREDENTIAL_KEYS]);

export interface RuntimeProfile {
  version: 1;
  environment: Record<string, string>;
  environmentFile?: string;
}

function validateEnvironment(value: unknown, allowed = ALLOWED_KEYS): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Runtime environment must be a JSON object.");
  const env: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!allowed.has(key)) throw new Error(`Unsupported runtime environment variable: ${key}`);
    if (typeof item !== "string" || item.includes("\0")) throw new Error(`Invalid runtime environment variable: ${key}`);
    env[key] = item;
  }
  return env;
}

function readPrivateJson(path: string): unknown {
  if (!isAbsolute(path)) throw new Error("Runtime configuration paths must be absolute.");
  const stat = lstatSync(path);
  if (!stat.isFile() || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) {
    throw new Error("Runtime configuration must be an owned private file (chmod 600).");
  }
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch { throw new Error("Invalid runtime configuration JSON."); }
}

export function captureRuntimeProfile(env: NodeJS.ProcessEnv, environmentFile?: string): RuntimeProfile {
  const referenced = environmentFile ? validateEnvironment(readPrivateJson(environmentFile)) : {};
  // Never silently discard keys that made the interactive runtime usable.
  const missing = [...CREDENTIAL_KEYS].filter(key => !SETTING_KEYS.has(key) && env[key] && referenced[key] === undefined);
  if (missing.length) throw new Error(`Background runtime settings require --runtime-env-file (private JSON): ${missing.join(", ")}. Saved CLI login is also supported.`);
  const environment = Object.fromEntries([...SETTING_KEYS].flatMap(key => env[key] === undefined ? [] : [[key, env[key]!]]));
  return { version: 1, environment, ...(environmentFile ? { environmentFile } : {}) };
}

export function writeRuntimeProfile(stateDir: string, profile: RuntimeProfile): string {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const path = join(stateDir, "runtime-profile.json");
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(profile, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    renameSync(temporary, path);
  } finally { rmSync(temporary, { force: true }); }
  return path;
}

export function loadRuntimeProfile(path: string): Record<string, string> {
  return runtimeProfileEnvironment(readPrivateJson(path));
}

export function runtimeProfileEnvironment(value: unknown): Record<string, string> {
  const raw = value as Partial<RuntimeProfile> | null;
  if (!raw || raw.version !== 1 || Object.keys(raw).some(key => !["version", "environment", "environmentFile"].includes(key))) throw new Error("Unsupported runtime profile.");
  const env = validateEnvironment(raw.environment, SETTING_KEYS);
  if (raw.environmentFile !== undefined) {
    if (typeof raw.environmentFile !== "string") throw new Error("Invalid runtime environment file reference.");
    Object.assign(env, validateEnvironment(readPrivateJson(raw.environmentFile)));
  }
  return env;
}
