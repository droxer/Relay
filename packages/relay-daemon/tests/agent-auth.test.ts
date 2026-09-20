import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
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
    const originalAuth = '{"saved":{"type":"api_key","key":"saved-key"}}';
    const originalModels = '{"providers":{"saved":{"models":[]}}}';
    writeFileSync(join(source, "auth.json"), originalAuth);
    writeFileSync(join(source, "models.json"), originalModels);
    writeFileSync(join(source, "settings.json"), '{"theme":"dark"}');
    const target = prepareLocalPiAuth();
    assert.notEqual(target, source);
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
