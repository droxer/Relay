import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentName } from "relay-core";
import {
  MAX_MODELS_PER_AGENT,
  anthropicApiModels,
  buildModelDiscoveryScript,
  claudeAccountModels,
  claudeHelpAliases,
  codexCatalogModels,
  discoverAgentModels,
  kimiConfigModels,
  parseAgentModels,
  piListedModels,
} from "../src/agent-models.js";

type ExecResult = { exit_code: number; stdout: string; stderr: string };

function record(source: string, text: string): string {
  return `${source}\t${Buffer.from(text, "utf8").toString("base64")}\n`;
}

const CLAUDE_HELP = `Options:
  --fallback-model <model>              Enable automatic fallback to specified
                                        model(s) when the default model is
                                        overloaded (e.g. 'haiku')
  --model <model>                       Model for the current session. Provide
                                        an alias for the latest model (e.g.
                                        'fable', 'opus', or 'sonnet') or a
                                        model's full name.
  --permission-mode <mode>              Permission mode (e.g. 'plan')
`;

/** What the sweep's grep keeps from Claude's `.claude.json`. */
const CLAUDE_ACCOUNT_CACHE = `"additionalModelOptionsCache": [    {      "value": "claude-fable-5-1[1m]",      "label": "Fable",      "description": "Fable 5.1"    },    {"value":"claude-opus-5-5","label":"Opus"}  ]`;

const ANTHROPIC_MODELS = JSON.stringify({
  data: [
    { type: "model", id: "claude-opus-5-5", display_name: "Claude Opus 5.5" },
    { type: "model", id: "claude-sonnet-5-5", display_name: "Claude Sonnet 5.5" },
    { type: "model", id: "claude-haiku-5-5", display_name: "Claude Haiku 5.5" },
  ],
  has_more: false,
});

/** What the sweep's grep keeps from `codex debug models`. */
function codexTokens(models: Array<Record<string, string | number>>): string {
  return models.flatMap((model) => Object.entries(model).map(([key, value]) => `"${key}":${JSON.stringify(value)}`)).join("\n");
}

const CODEX_CATALOG = codexTokens([
  { slug: "gpt-6-luna", visibility: "list", priority: 4 },
  { slug: "gpt-reserve", visibility: "hide", priority: 4 },
  { slug: "gpt-5.6-luna", visibility: "list", priority: 9 },
  { slug: "gpt-5.6-terra", visibility: "list", priority: 8 },
]);

const PI_TABLE = `provider    model                       context  max-out  thinking  images
anthropic   claude-haiku-4-5            200K     64K      yes       yes
openai      gpt-5                       400K     128K     yes       yes
`;

const KIMI_CONFIG = `default_model = "kimi-code/k3"

[loop_control]
max_steps_per_turn = 100

[models."kimi-code/kimi-for-coding"]
provider = "managed:kimi-code"
model = "kimi-for-coding"

[models."kimi-code/k3"]
provider = "managed:kimi-code"
model = "k3"

[models."kimi-code/k3".capabilities]
thinking = true

[models.local]
provider = "ollama"
`;

describe("agent model discovery", () => {
  it("reads Claude's aliases from the --model option only", () => {
    assert.deepEqual(claudeHelpAliases(CLAUDE_HELP), ["fable", "opus", "sonnet"]);
    assert.deepEqual(claudeHelpAliases("Usage: claude"), []);
  });

  it("lets Claude's availableModels setting replace the help aliases", () => {
    const stdout = record("help", CLAUDE_HELP)
      + record("settings", JSON.stringify({ availableModels: ["opus", "claude-opus-5-5"], model: "sonnet" }));
    assert.deepEqual(parseAgentModels("claude", stdout), ["opus", "claude-opus-5-5"]);
  });

  it("adds Claude's configured model after its aliases", () => {
    const stdout = record("help", CLAUDE_HELP) + record("settings", JSON.stringify({ model: "claude-opus-5-5" }));
    assert.deepEqual(parseAgentModels("claude", stdout), ["fable", "opus", "sonnet", "claude-opus-5-5"]);
  });

  it("reads the model options Claude caches for the signed-in account", () => {
    assert.deepEqual(claudeAccountModels(CLAUDE_ACCOUNT_CACHE), ["claude-fable-5-1[1m]", "claude-opus-5-5"]);
    assert.deepEqual(claudeAccountModels('"additionalModelOptionsCache": []'), []);
    assert.deepEqual(claudeAccountModels("not json"), []);
  });

  it("reads the provider's model list", () => {
    assert.deepEqual(anthropicApiModels(ANTHROPIC_MODELS), ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"]);
    assert.deepEqual(anthropicApiModels('{"type":"error","error":{"type":"authentication_error"}}'), []);
    assert.deepEqual(anthropicApiModels("<html>"), []);
  });

  it("offers Claude's versioned models from the provider instead of bare aliases", () => {
    const stdout = record("help", CLAUDE_HELP)
      + record("settings", JSON.stringify({ model: "opus" }))
      + record("account", CLAUDE_ACCOUNT_CACHE)
      + record("api", ANTHROPIC_MODELS);
    assert.deepEqual(parseAgentModels("claude", stdout), [
      "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5",
      "claude-fable-5-1[1m]",
    ]);
  });

  it("falls back to Claude's aliases when the provider cannot be asked", () => {
    const stdout = record("help", CLAUDE_HELP) + record("account", CLAUDE_ACCOUNT_CACHE);
    assert.deepEqual(parseAgentModels("claude", stdout), ["fable", "opus", "sonnet", "claude-fable-5-1[1m]", "claude-opus-5-5"]);
  });

  it("keeps Claude's availableModels allowlist as the whole menu", () => {
    const stdout = record("settings", JSON.stringify({ availableModels: ["sonnet"] }))
      + record("account", CLAUDE_ACCOUNT_CACHE)
      + record("api", ANTHROPIC_MODELS);
    assert.deepEqual(parseAgentModels("claude", stdout), ["sonnet"]);
  });

  it("asks the provider for Claude's models without putting the credential in argv", () => {
    const script = buildModelDiscoveryScript("claude");
    assert.match(script, /\/v1\/models/);
    assert.match(script, /-H @-/);
    assert.doesNotMatch(script, /curl[^\n]*\$(ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_AUTH_TOKEN)/);
    assert.match(script, /additionalModelOptionsCache/);
  });

  it("falls back to Claude Code's own saved login without exposing the token", async () => {
    const script = buildModelDiscoveryScript("claude");
    assert.match(script, /\.credentials\.json/);
    assert.match(script, /security find-generic-password -s "Claude Code-credentials" -w/);
    assert.doesNotMatch(script, /curl[^\n]*\$token/);

    // Run the real sweep against a fake saved login and a stub curl that
    // echoes the headers it read from stdin: the token must arrive there.
    const { mkdtempSync, mkdirSync, writeFileSync, chmodSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const { execFileSync } = await import("node:child_process");
    const root = mkdtempSync(join(tmpdir(), "claude-login-"));
    const home = join(root, "home");
    const bin = join(root, "bin");
    mkdirSync(join(home, ".claude"), { recursive: true });
    mkdirSync(bin);
    writeFileSync(join(home, ".claude", ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "saved-login-token" } }));
    writeFileSync(join(bin, "curl"), `#!/bin/sh\nheaders=$(cat)\ncase "$headers" in *"Bearer saved-login-token"*) printf '%s' '${ANTHROPIC_MODELS}';; esac\n`);
    chmodSync(join(bin, "curl"), 0o755);
    const stdout = execFileSync("bash", ["-c", script], {
      env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home },
    }).toString();
    assert.deepEqual(parseAgentModels("claude", stdout), ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"]);
    assert.doesNotMatch(stdout, /saved-login-token/);
  });

  it("offers Codex's listed models in catalog priority order and hides internal ones", () => {
    assert.deepEqual(codexCatalogModels(CODEX_CATALOG), ["gpt-6-luna", "gpt-5.6-terra", "gpt-5.6-luna"]);
    assert.deepEqual(codexCatalogModels("not a catalog"), []);
  });

  it("keeps each Codex model's own visibility over a nested one", () => {
    const tokens = codexTokens([
      { slug: "gpt-6-luna", visibility: "hide", priority: 4 },
      { slug: "gpt-6-luna-upgrade", visibility: "list", priority: 1 },
    ]) + '\n"visibility":"list"\n"priority":0';
    assert.deepEqual(codexCatalogModels(tokens), ["gpt-6-luna-upgrade"]);
  });

  it("dedupes the Codex CLI catalog against its cache file", () => {
    const stdout = record("catalog", CODEX_CATALOG) + record("catalog", CODEX_CATALOG);
    assert.deepEqual(parseAgentModels("codex", stdout), ["gpt-6-luna", "gpt-5.6-terra", "gpt-5.6-luna"]);
  });

  it("qualifies Pi's listed models by provider and ignores text before the table", () => {
    assert.deepEqual(
      piListedModels(`Warning: something\n${PI_TABLE}`),
      ["anthropic/claude-haiku-4-5", "openai/gpt-5"],
    );
    assert.deepEqual(piListedModels("No models available."), []);
  });

  it("lists Kimi's config aliases with the default first and skips subtables", () => {
    assert.deepEqual(kimiConfigModels("[loop_control]\ndefault_model = \"not-root\"\n"), []);
    assert.deepEqual(parseAgentModels("kimi", record("config", KIMI_CONFIG)), ["kimi-code/k3", "kimi-code/kimi-for-coding", "local"]);
  });

  it("drops ids the model policy would refuse and caps the list", () => {
    const catalog = codexTokens([
      { slug: "bad id" },
      { slug: "-leading-dash" },
      { slug: "x".repeat(129) },
      ...Array.from({ length: MAX_MODELS_PER_AGENT + 5 }, (_, index) => ({ slug: `m-${index}` })),
    ]);
    const models = parseAgentModels("codex", record("catalog", catalog));
    assert.equal(models.length, MAX_MODELS_PER_AGENT);
    assert.equal(models[0], "m-0");
  });

  it("asks each runtime with its own credentials and omits runtimes that report nothing", async () => {
    const outputs: Partial<Record<AgentName, string>> = {
      codex: record("catalog", CODEX_CATALOG),
      pi: "",
    };
    const calls: Array<{ script: string; env?: Record<string, string> }> = [];
    const exec = async (_cmd: string, args?: string[], options?: { env?: Record<string, string> }): Promise<ExecResult> => {
      const script = args?.[1] ?? "";
      calls.push({ script, env: options?.env });
      const agent = script.includes("codex debug models") ? "codex" : "pi";
      return { exit_code: 0, stdout: outputs[agent] ?? "", stderr: "" };
    };
    const models = await discoverAgentModels(exec, ["codex", "pi"]);
    assert.deepEqual(models, { codex: ["gpt-6-luna", "gpt-5.6-terra", "gpt-5.6-luna"] });
    assert.equal(calls.length, 2);
    assert.ok(calls.every((call) => call.env !== undefined));
  });

  it("keeps Claude's last versioned list when its saved login has since expired", async () => {
    const sweeps = [
      record("help", CLAUDE_HELP) + record("api", ANTHROPIC_MODELS),
      record("help", CLAUDE_HELP) + record("account", CLAUDE_ACCOUNT_CACHE),
    ];
    const exec = async (): Promise<ExecResult> => ({ exit_code: 0, stdout: sweeps.shift() ?? "", stderr: "" });
    const memory = new Map();
    const first = await discoverAgentModels(exec, ["claude"], undefined, undefined, memory);
    const second = await discoverAgentModels(exec, ["claude"], undefined, undefined, memory);
    assert.deepEqual(first.claude, ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"]);
    assert.deepEqual(second.claude, ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-1[1m]"]);
  });

  it("never throws when a runtime cannot be asked", async () => {
    const throwing = async (): Promise<ExecResult> => {
      throw new Error("exec exploded");
    };
    const failing = async (): Promise<ExecResult> => ({ exit_code: 1, stdout: record("catalog", CODEX_CATALOG), stderr: "" });
    assert.deepEqual(await discoverAgentModels(throwing, ["codex"]), {});
    assert.deepEqual(await discoverAgentModels(failing, ["codex"]), {});
    assert.deepEqual(await discoverAgentModels(throwing, []), {});
  });

  it("aborts a hung sweep at its deadline", async () => {
    let aborted = false;
    const hanging = async (_cmd: string, _args?: string[], options?: { signal?: AbortSignal }): Promise<ExecResult> =>
      await new Promise<ExecResult>((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => {
          aborted = true;
          reject(new Error("aborted"));
        }, { once: true });
      });
    assert.deepEqual(await discoverAgentModels(hanging, ["claude"], undefined, 5), {});
    assert.equal(aborted, true);
  });

  it("builds a sweep script that only probes the runtime it is for", () => {
    const script = buildModelDiscoveryScript("pi");
    assert.match(script, /pi --list-models/);
    assert.doesNotMatch(script, /codex|claude|kimi/);
  });
});
