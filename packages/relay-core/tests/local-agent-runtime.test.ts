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
