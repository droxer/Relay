import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runRelayDaemonDoctor } from "../src/index.js";
import { assertKimiConfigured, prepareLocalPiAuth } from "../src/agent-auth.js";

function fixture(env: NodeJS.ProcessEnv, action: (home: string) => void): void {
  const home = mkdtempSync(join(tmpdir(), "relay-agent-auth-"));
  const previous = process.env;
  process.env = { ...env, RELAY_AGENT_HOME: home, RELAY_RUN_AS_CURRENT_USER: "1" };
  try { action(home); } finally { process.env = previous; rmSync(home, { recursive: true, force: true }); }
}

test("local Pi provisions the selected provider without modifying user config", () => {
  fixture({ ANTHROPIC_API_KEY: "unrelated-secret", OPENAI_API_KEY: "selected-secret", OPENAI_BASE_URL: "https://example.invalid/v1", OPENAI_MODEL: "custom-model" }, (home) => {
    const source = join(home, ".pi", "agent");
    mkdirSync(source, { recursive: true });
    mkdirSync(join(home, "shared-skills"));
    symlinkSync(join(home, "shared-skills"), join(source, "skills"), "dir");
    const originalAuth = '{"saved":{"type":"api_key","key":"saved-key"}}';
    const originalModels = '{"providers":{"saved":{"models":[]}}}';
    writeFileSync(join(source, "auth.json"), originalAuth);
    writeFileSync(join(source, "models.json"), originalModels);
    writeFileSync(join(source, "settings.json"), '{"theme":"dark"}');
    const target = prepareLocalPiAuth();
    assert.notEqual(target, source);
    assert.equal(statSync(join(target, "skills")).isDirectory(), true);
    assert.equal(readFileSync(join(source, "auth.json"), "utf8"), originalAuth);
    assert.equal(readFileSync(join(source, "models.json"), "utf8"), originalModels);
    const auth = JSON.parse(readFileSync(join(target, "auth.json"), "utf8"));
    assert.equal(auth.openai.key, "selected-secret");
    assert.equal(auth.anthropic, undefined);
    assert.equal(auth.saved.key, "saved-key");
    const models = JSON.parse(readFileSync(join(target, "models.json"), "utf8"));
    assert.equal(models.providers.openai.models[0].id, "custom-model");
    assert.ok(models.providers.saved);
    assert.equal(readFileSync(join(target, "settings.json"), "utf8"), '{"theme":"dark"}');
    assert.equal(statSync(join(target, "auth.json")).mode & 0o777, 0o600);
    assert.equal(prepareLocalPiAuth(), target);
  });
});

test("local Pi preserves existing login when no Relay credentials are supplied", () => {
  fixture({}, (home) => assert.equal(prepareLocalPiAuth(), join(home, ".pi", "agent")));
});

test("Kimi readiness rejects absent config, model, provider and credentials", () => {
  fixture({}, (home) => {
    assert.throws(() => assertKimiConfigured(home), /Kimi.*config/i);
    for (const config of [
      'default_model = "missing"',
      'default_model = "test"\n[models.test]\nprovider = "missing"\nmodel = "kimi-k2.5"',
      'default_model = "test"\n[models.test]\nprovider = "kimi"\nmodel = "kimi-k2.5"\n[providers.kimi]\ntype = "kimi"',
    ]) {
      writeFileSync(join(home, "config.toml"), config);
      assert.throws(() => assertKimiConfigured(home), /Kimi/);
    }
  });
});

test("Kimi readiness accepts configured API keys and refreshable OAuth", () => {
  fixture({}, (home) => {
    const model = 'default_model = "test"\n[models.test]\nprovider = "kimi"\nmodel = "kimi-k2.5"\n[providers.kimi]\ntype = "kimi"\n';
    writeFileSync(join(home, "config.toml"), model + 'api_key = "test-key"');
    assert.doesNotThrow(() => assertKimiConfigured(home));
    writeFileSync(join(home, "config.toml"), model + '[providers.kimi.oauth]\nstorage = "file"\nkey = "oauth/kimi-code"');
    assert.throws(() => assertKimiConfigured(home), /credential/i);
    mkdirSync(join(home, "credentials"));
    writeFileSync(join(home, "credentials", "kimi-code.json"), JSON.stringify({ access_token: "expired-token", refresh_token: "refresh-token", expires_at: 1 }));
    assert.doesNotThrow(() => assertKimiConfigured(home));
  });
});

test("Kimi env-key setup requires a model and works without saved config", () => {
  fixture({ KIMI_API_KEY: "test-key" }, (home) => {
    assert.throws(() => assertKimiConfigured(home), /KIMI_MODEL/);
    process.env.KIMI_MODEL = "kimi-k2.5";
    assert.doesNotThrow(() => assertKimiConfigured(home));
  });
});

test("Kimi native model env and provider env credentials are accepted", () => {
  fixture({ KIMI_MODEL_NAME: "native-model", KIMI_MODEL_API_KEY: "native-key" }, (home) => {
    assert.doesNotThrow(() => assertKimiConfigured(home));
    delete process.env.KIMI_MODEL_API_KEY;
    assert.throws(() => assertKimiConfigured(home), /KIMI_MODEL_API_KEY/);
    delete process.env.KIMI_MODEL_NAME;
    writeFileSync(join(home, "config.toml"), 'default_model = "test"\n[models.test]\nprovider = "kimi"\nmodel = "kimi-k2.5"\n[providers.kimi]\ntype = "kimi"\n[providers.kimi.env]\nKIMI_API_KEY = "test-key"');
    assert.doesNotThrow(() => assertKimiConfigured(home));
    process.env.KIMI_MODEL = "missing";
    assert.throws(() => assertKimiConfigured(home), /selected model/);
  });
});

test("Kimi rejects revoked and expired OAuth without a refresh token", () => {
  fixture({}, (home) => {
    writeFileSync(join(home, "config.toml"), 'default_model = "test"\n[models.test]\nprovider = "kimi"\nmodel = "kimi-k2.5"\n[providers.kimi]\ntype = "kimi"\n[providers.kimi.oauth]\nstorage = "file"\nkey = "oauth/kimi-code"');
    mkdirSync(join(home, "credentials"));
    const path = join(home, "credentials", "kimi-code.json");
    for (const token of [{ access_token: "", refresh_token: "refresh" }, { access_token: "expired", expires_at: 1 }]) {
      writeFileSync(path, JSON.stringify(token));
      assert.throws(() => assertKimiConfigured(home), /credentials/);
    }
    writeFileSync(path, JSON.stringify({ access_token: "valid", expires_at: Date.now() / 1000 + 3600 }));
    assert.doesNotThrow(() => assertKimiConfigured(home));
  });
});

test("local Pi isolates provider settings and rejects malformed config without exposing secrets", () => {
  fixture({ PI_API_KEY: "first-key", PI_PROVIDER: "anthropic" }, (home) => {
    const first = prepareLocalPiAuth();
    process.env.PI_API_KEY = "second-key";
    assert.notEqual(prepareLocalPiAuth(), first);
    const source = join(home, ".pi", "agent");
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, "auth.json"), '{"key":"private-secret" broken');
    assert.throws(() => prepareLocalPiAuth(), (error: unknown) => {
      assert.match(String(error), /Invalid agent configuration/);
      assert.doesNotMatch(String(error), /private-secret/);
      return true;
    });
  });
});


test("local daemon doctor uses Pi runtime auth and refuses an unconfigured Kimi", async () => {
  const home = mkdtempSync(join(tmpdir(), "relay-agent-doctor-"));
  const previous = process.env;
  const bin = join(home, "bin");
  mkdirSync(bin);
  for (const cli of ["claude", "codex", "kimi"]) {
    writeFileSync(join(bin, cli), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  }
  const pi = join(bin, "pi");
  writeFileSync(pi, `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const auth = JSON.parse(fs.readFileSync(path.join(process.env.PI_CODING_AGENT_DIR, 'auth.json')));
const models = JSON.parse(fs.readFileSync(path.join(process.env.PI_CODING_AGENT_DIR, 'models.json')));
if (auth.openai.key !== 'pi-test-key' || models.providers.openai.models[0].id !== 'custom-model' || process.env.OPENAI_API_KEY) process.exit(1);
console.log('openai custom-model');
`);
  chmodSync(pi, 0o755);
  process.env = { PATH: `${bin}:${previous.PATH}`, OPENAI_API_KEY: "pi-test-key", OPENAI_BASE_URL: "https://example.invalid/v1", OPENAI_MODEL: "custom-model" };
  try {
    const report = await runRelayDaemonDoctor({
      sandbox: "none", allowHostAgentExecution: true, agentHome: home,
      sandboxId: "test-node", workspacePath: home, stateDir: join(home, "state"), token: "test-node-token",
      backendUrl: "http://relay.test", fetchFn: async () => new Response("{}", { status: 200 }),
      logger: { info() {}, warn() {}, error() {}, output() {} },
    });
    assert.equal(report.checks.find((check) => check.name === "agent:pi")?.ok, true);
    assert.equal(report.checks.find((check) => check.name === "agent:codex")?.ok, true);
    assert.equal(report.checks.find((check) => check.name === "agent:kimi")?.ok, false);
  } finally {
    process.env = previous;
    rmSync(home, { recursive: true, force: true });
  }
});
