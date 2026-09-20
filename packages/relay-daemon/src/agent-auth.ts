import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parse } from "smol-toml";
import { kimiApiKey, kimiModel, localRuntimeEnvironment } from "relay-core";

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
export function assertKimiConfigured(home: string, options: { native?: boolean } = {}): void {
  const env = options.native ? localRuntimeEnvironment() : process.env;
  const key = options.native ? (env.KIMI_MODEL_NAME ? env.KIMI_MODEL_API_KEY : undefined) : kimiApiKey();
  const selectedModel = options.native ? env.KIMI_MODEL_NAME : kimiModel();
  if (key || env.KIMI_MODEL_NAME) {
    if (!key?.trim()) throw new Error("Kimi requires KIMI_MODEL_API_KEY when KIMI_MODEL_NAME is set.");
    if (!selectedModel?.trim()) throw new Error("Kimi API-key authentication requires KIMI_MODEL (or KIMI_MODEL_NAME/MOONSHOT_MODEL).");
    return;
  }
  let config: Record<string, unknown>;
  try {
    config = parse(readFileSync(join(home, "config.toml"), "utf8"));
  } catch {
    throw new Error(options.native
      ? "Kimi requires a valid native config.toml with a model and credentials. Run kimi login with the same KIMI_CODE_HOME."
      : "Kimi requires a valid config.toml with a model and credentials. Run kimi login or set KIMI_API_KEY and KIMI_MODEL.");
  }
  const alias = selectedModel || text(config.default_model);
  const model = record(record(config.models)[alias ?? ""]);
  if (!alias || !text(model.model)) {
    throw new Error(options.native
      ? "Kimi saved default_model is not configured. Select a model in the installed Kimi CLI."
      : "Kimi selected model is not configured. Set default_model or KIMI_MODEL to a configured alias.");
  }
  const providerName = text(model.provider);
  const provider = providerName ? record(record(config.providers)[providerName]) : model;
  if (providerName && Object.keys(provider).length === 0) throw new Error("Kimi selected model references an unconfigured provider.");
  if (!providerName && !text(model.base_url)) throw new Error("Kimi selected model has no provider or base_url.");
  if (text(provider.api_key)) return;
  const providerEnv = record(provider.env);
  const keyName = ({ kimi: "KIMI_API_KEY", anthropic: "ANTHROPIC_API_KEY", openai: "OPENAI_API_KEY", openai_responses: "OPENAI_API_KEY", "google-genai": "GOOGLE_API_KEY" } as Record<string, string>)[text(provider.type) ?? "kimi"];
  if (keyName && text(providerEnv[keyName])) return;
  const oauth = record(provider.oauth);
  const oauthKey = text(oauth.key);
  if ((oauth.storage === undefined || oauth.storage === "file") && oauthKey?.startsWith("oauth/") && basename(oauthKey) === oauthKey.slice(6)) {
    const credentials = readJsonObject(join(home, "credentials", `${basename(oauthKey)}.json`));
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
