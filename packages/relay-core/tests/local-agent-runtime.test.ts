import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import assert from "node:assert/strict";
import { test } from "node:test";
import { agentCredentialEnv, buildClaudeCommand, buildCodexCommand, buildKimiCommand, buildPiCommand, buildPiPreflightCommand, initialAgentState } from "../src/index.js";

function local(action: () => void): void {
  const previous = process.env;
  process.env = {
    RELAY_RUN_AS_CURRENT_USER: "1", RELAY_AGENT_HOME: "/user/home",
    OPENAI_BASE_URL: "https://relay-provider.invalid/v1", OPENAI_MODEL: "relay-model",
    PI_PROVIDER: "relay-provider", PI_MODEL: "relay-pi-model", ANTHROPIC_MODEL: "relay-claude-model",
    KIMI_MODEL: "relay-kimi-model", LLM_API_KEY: "relay-alias", CLAUDE_API_KEY: "relay-claude-alias",
    CODEX_HOME: "/user/codex", PI_CODING_AGENT_DIR: "/user/pi", KIMI_CODE_HOME: "/user/kimi",
  };
  try { action(); } finally { process.env = previous; }
}

test("local commands leave provider and model selection to installed runtimes", () => local(() => {
  for (const build of [buildClaudeCommand, buildCodexCommand, buildPiCommand, buildKimiCommand]) {
    const command = build(initialAgentState("task"));
    assert.doesNotMatch(command, /relay-model|relay-pi-model|relay-claude-model|relay-kimi-model|relay-provider|model_provider|features\.multi_agent/);
    assert.doesNotMatch(command, /stdbuf/);
    assert.doesNotMatch(command, /export (CODEX_HOME|PI_CODING_AGENT_DIR|KIMI_CODE_HOME)=/);
  }
  assert.doesNotMatch(buildPiPreflightCommand(), /relay-provider|relay-pi-model/);
}));

test("local credential resolution uses native variables without translating Relay aliases", () => local(() => {
  assert.deepEqual(agentCredentialEnv("claude"), [["ANTHROPIC_MODEL", "relay-claude-model"]]);
  assert.equal(Object.fromEntries(agentCredentialEnv("codex")).OPENAI_API_KEY, undefined);
  assert.equal(Object.fromEntries(agentCredentialEnv("kimi")).KIMI_MODEL_NAME, undefined);
  process.env.KIMI_MODEL_NAME = "user-model";
  process.env.KIMI_MODEL_API_KEY = "user-key";
  assert.equal(Object.fromEntries(agentCredentialEnv("kimi")).KIMI_MODEL_API_KEY, "user-key");
  process.env.ANTHROPIC_API_KEY = "native-anthropic-key";
  assert.equal(Object.fromEntries(agentCredentialEnv("pi")).ANTHROPIC_API_KEY, "native-anthropic-key");
  assert.equal(Object.fromEntries(agentCredentialEnv("pi")).PI_API_KEY, undefined);
}));

test("local execution excludes Relay dotenv credentials but preserves the native launch environment", () => {
  const directory = mkdtempSync(join(tmpdir(), "relay-native-env-"));
  try {
    writeFileSync(join(directory, ".env"), "ANTHROPIC_API_KEY=relay-key\nKIMI_MODEL_API_KEY=relay-kimi-key\nCODEX_HOME=/relay/config\n");
    const moduleUrl = new URL("../src/index.js", import.meta.url).href;
    const output = execFileSync(process.execPath, ["--input-type=module", "-e", `
      const {localRuntimeEnvironment, agentCredentialEnv} = await import(${JSON.stringify(moduleUrl)});
      const env = localRuntimeEnvironment();
      console.log(JSON.stringify({
        noRelayKey: !env.ANTHROPIC_API_KEY && !env.KIMI_MODEL_API_KEY,
        ownHome: env.CODEX_HOME === '/user/custom-codex',
        ownKey: Object.fromEntries(agentCredentialEnv('codex')).CODEX_API_KEY === 'user-key',
        noClaudeInjection: agentCredentialEnv('claude').length === 0,
      }));
    `], {
      cwd: directory, encoding: "utf8",
      env: { PATH: process.env.PATH, HOME: directory, RELAY_RUN_AS_CURRENT_USER: "1", CODEX_HOME: "/user/custom-codex", CODEX_API_KEY: "user-key" },
    });
    assert.deepEqual(JSON.parse(output), { noRelayKey: true, ownHome: true, ownKey: true, noClaudeInjection: true });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("local managed skills do not replace the user's authorization home", () => local(() => {
  const state = { ...initialAgentState("task"), skill_paths: ["/relay/skills/review"], skill_env: { CLAUDE_CONFIG_DIR: "/relay/isolated-claude", CODEX_HOME: "/relay/isolated-codex" } };
  for (const build of [buildClaudeCommand, buildCodexCommand]) {
    const command = build(state);
    assert.doesNotMatch(command, /isolated-claude|isolated-codex/);
    assert.match(command, /\/relay\/skills\/review\/SKILL\.md/);
  }
}));
