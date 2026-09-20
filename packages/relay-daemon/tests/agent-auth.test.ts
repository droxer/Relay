import { AGENT_NAMES, initialAgentState, runAgentNode } from "relay-core";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { localProcessExecStream, runRelayDaemonDoctor } from "../src/index.js";
import { assertKimiConfigured } from "../src/agent-auth.js";

function fixture(env: NodeJS.ProcessEnv, action: (home: string) => void): void {
  const home = mkdtempSync(join(tmpdir(), "relay-agent-auth-"));
  const previous = process.env;
  process.env = { ...env, RELAY_AGENT_HOME: home, RELAY_RUN_AS_CURRENT_USER: "1" };
  try { action(home); } finally { process.env = previous; rmSync(home, { recursive: true, force: true }); }
}

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

test("local daemon doctor uses saved Pi login without changing configuration", async () => {
  const home = mkdtempSync(join(tmpdir(), "relay-agent-doctor-"));
  const previous = process.env;
  const bin = join(home, "bin");
  mkdirSync(bin);
  for (const cli of ["claude", "codex", "kimi"]) {
    writeFileSync(join(bin, cli), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  }
  const piHome = join(home, ".pi", "agent");
  mkdirSync(piHome, { recursive: true });
  const authContent = '{"saved":{"type":"api_key","key":"user-key"}}';
  const modelContent = '{"providers":{"saved":{"models":[{"id":"user-model"}]}}}';
  writeFileSync(join(piHome, "auth.json"), authContent);
  writeFileSync(join(piHome, "models.json"), modelContent);
  const pi = join(bin, "pi");
  writeFileSync(pi, `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const auth = JSON.parse(fs.readFileSync(path.join(process.env.PI_CODING_AGENT_DIR, 'auth.json')));
const models = JSON.parse(fs.readFileSync(path.join(process.env.PI_CODING_AGENT_DIR, 'models.json')));
if (auth.saved.key !== 'user-key' || models.providers.saved.models[0].id !== 'user-model' || process.env.LLM_API_KEY || process.argv.includes('--model') || process.argv.includes('--provider')) process.exit(1);
console.log('saved user-model');
`);
  chmodSync(pi, 0o755);
  process.env = { PATH: `${bin}:${previous.PATH}`, LLM_API_KEY: "relay-key", OPENAI_BASE_URL: "https://example.invalid/v1", OPENAI_MODEL: "custom-model" };
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
    assert.equal(readFileSync(join(piHome, "auth.json"), "utf8"), authContent);
    assert.equal(readFileSync(join(piHome, "models.json"), "utf8"), modelContent);
    assert.equal(existsSync(join(home, ".relay", "pi")), false);
    assert.equal(existsSync(join(home, ".claude", "skills")), false);
  } finally {
    process.env = previous;
    rmSync(home, { recursive: true, force: true });
  }
});


test("all local runtimes launch from PATH using their existing custom auth directories", async () => {
  const home = mkdtempSync(join(tmpdir(), "relay-native-clis-"));
  const previous = process.env;
  const homes = { claude: "CLAUDE_CONFIG_DIR", codex: "CODEX_HOME", pi: "PI_CODING_AGENT_DIR", kimi: "KIMI_CODE_HOME" };
  const bin = join(home, "bin");
  mkdirSync(bin);
  process.env = { PATH: `${bin}:/usr/bin:/bin`, RELAY_RUN_AS_CURRENT_USER: "1", RELAY_AGENT_HOME: home, RELAY_AGENT_WORKSPACE: home, OPENAI_MODEL: "relay-model", PI_PROVIDER: "relay-provider", KIMI_MODEL: "relay-model" };
  try {
    for (const agent of AGENT_NAMES) {
      const nativeHome = join(home, `native-${agent}`);
      mkdirSync(nativeHome);
      writeFileSync(join(nativeHome, "login"), "existing-user-login");
      process.env[homes[agent]] = nativeHome;
      const cli = join(bin, agent);
      writeFileSync(cli, `#!${process.execPath}
const fs = require('node:fs');
const p = require('node:path');
if (process.argv.includes('--help')) { console.log('--mode'); process.exit(0); }
if (fs.readFileSync(p.join(process.env[${JSON.stringify(homes[agent])}], 'login'), 'utf8') !== 'existing-user-login') process.exit(10);
if (process.argv.includes('--model') || process.argv.includes('--provider') || process.argv.includes('-m')) process.exit(11);
console.log('native-runtime-ok');
`, { mode: 0o755 });
      const result = await runAgentNode(agent, initialAgentState("task"), { execStream: localProcessExecStream, workspacePath: home });
      assert.equal(result.last_exit_code, 0, agent);
      assert.equal(readFileSync(join(nativeHome, "login"), "utf8"), "existing-user-login");
    }
  } finally { process.env = previous; rmSync(home, { recursive: true, force: true }); }
});

test("local Kimi uses the saved model despite Relay-only key and model settings", () => {
  fixture({ KIMI_API_KEY: "relay-key", KIMI_MODEL: "not-a-native-alias" }, (home) => {
    writeFileSync(join(home, "config.toml"), 'default_model = "saved"\n[models.saved]\nprovider = "kimi"\nmodel = "user-model"\n[providers.kimi]\ntype = "kimi"\napi_key = "user-key"');
    assert.doesNotThrow(() => assertKimiConfigured(home, { native: true }));
  });
});
