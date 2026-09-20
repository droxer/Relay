import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, statSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parse } from "smol-toml";
import {
  agentHomePath, guestPiAuthJson, guestPiModelsJson, kimiApiKey, kimiModel,
  piAgentDirectory, piProvider, requirePiConfig,
} from "relay-core";

/** Supply Relay settings without overwriting the operator's Pi login or models. */
export function prepareLocalPiAuth(): string {
  const source = join(agentHomePath(), ".pi", "agent");
  const target = piAgentDirectory();
  if (target === source) return source;
  requirePiConfig();
  mkdirSync(target, { recursive: true, mode: 0o700 });
  chmodSync(target, 0o700);
  if (existsSync(source)) {
    for (const name of readdirSync(source)) {
      if (name === "auth.json" || name === "models.json") continue;
      const from = join(source, name);
      const to = join(target, name);
      if (existsSync(to)) continue;
      if (statSync(from).isDirectory()) symlinkSync(from, to, "dir");
      else writePrivateFile(to, readFileSync(from, "utf8"));
    }
  }
  const auth = readJsonObject(join(source, "auth.json"));
  const models = readJsonObject(join(source, "models.json"));
  const generated = JSON.parse(guestPiModelsJson()) as { providers: Record<string, Record<string, unknown>> };
  const provider = generated.providers[piProvider()];
  if (provider) {
    // Both older Pi releases and the pinned image support command-valued keys.
    // The command contains only a variable reference; the secret stays in env.
    provider.apiKey = '!printf "%s" "$PI_API_KEY"';
  }
  writePrivateFile(join(target, "auth.json"), JSON.stringify({ ...auth, ...JSON.parse(guestPiAuthJson()) }));
  writePrivateFile(join(target, "models.json"), JSON.stringify({
    ...models, providers: { ...record(models.providers), ...generated.providers },
  }));
  return target;
}

function writePrivateFile(path: string, content: string): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, content, { mode: 0o600, flag: "wx" });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function readJsonObject(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch {
    // JSON parser errors can quote the input, which may contain credentials.
    throw new Error(`Invalid agent configuration at ${path}.`);
  }
}

/** Offline readiness checks configuration and stored credentials, never spends tokens. */
export function assertKimiConfigured(home: string): void {
  if (kimiApiKey() || process.env.KIMI_MODEL_NAME) {
    if (!kimiApiKey()?.trim()) throw new Error("Kimi requires KIMI_MODEL_API_KEY when KIMI_MODEL_NAME is set.");
    if (!kimiModel()?.trim()) throw new Error("Kimi API-key authentication requires KIMI_MODEL (or KIMI_MODEL_NAME/MOONSHOT_MODEL).");
    return;
  }
  let config: Record<string, unknown>;
  try {
    config = parse(readFileSync(join(home, "config.toml"), "utf8"));
  } catch {
    throw new Error("Kimi requires a valid config.toml with a model and credentials. Run kimi login or set KIMI_API_KEY and KIMI_MODEL.");
  }
  const alias = kimiModel() || text(config.default_model);
  const model = record(record(config.models)[alias ?? ""]);
  if (!alias || !text(model.model)) throw new Error("Kimi selected model is not configured. Set default_model or KIMI_MODEL to a configured alias.");
  const providerName = text(model.provider);
  const provider = providerName ? record(record(config.providers)[providerName]) : model;
  if (providerName && Object.keys(provider).length === 0) throw new Error("Kimi selected model references an unconfigured provider.");
  if (!providerName && !text(model.base_url)) throw new Error("Kimi selected model has no provider or base_url.");
  if (text(provider.api_key)) return;
  const env = record(provider.env);
  const keyName = ({ kimi: "KIMI_API_KEY", anthropic: "ANTHROPIC_API_KEY", openai: "OPENAI_API_KEY", openai_responses: "OPENAI_API_KEY", "google-genai": "GOOGLE_API_KEY" } as Record<string, string>)[text(provider.type) ?? "kimi"];
  if (keyName && text(env[keyName])) return;
  const oauth = record(provider.oauth);
  const key = text(oauth.key);
  if ((oauth.storage === undefined || oauth.storage === "file") && key?.startsWith("oauth/") && basename(key) === key.slice(6)) {
    const credentials = readJsonObject(join(home, "credentials", `${basename(key)}.json`));
    const expiresAt = typeof credentials.expires_at === "number" ? credentials.expires_at : 0;
    if (text(credentials.access_token) && (text(credentials.refresh_token) || expiresAt > Date.now() / 1000)) return;
  }
  throw new Error("Kimi selected model has no usable credentials. Run kimi login or configure its provider API key.");
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
