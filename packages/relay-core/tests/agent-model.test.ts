import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildClaudeCommand, buildCodexCommand, buildKimiCommand, buildPiCommand, customModelEndpointAgents, initialAgentState,
} from "../src/index.js";

function withEnv(env: Record<string, string>, action: () => void): void {
  const previous = process.env;
  process.env = { PATH: previous.PATH, ...env };
  try { action(); } finally { process.env = previous; }
}

const pinned = { ...initialAgentState("task"), agent_model: "pinned-model" };
const MANAGED_ENV = {
  OPENAI_MODEL: "env-openai", ANTHROPIC_MODEL: "env-claude", PI_MODEL: "env-pi", KIMI_MODEL: "env-kimi",
};

test("a pinned agent model replaces the daemon's env default on every runtime", () => withEnv(MANAGED_ENV, () => {
  assert.match(buildCodexCommand(pinned), /'-m' 'pinned-model'|-m pinned-model/);
  assert.match(buildClaudeCommand(pinned), /--model'? '?pinned-model/);
  assert.match(buildPiCommand(pinned), /--model'? '?pinned-model/);
  assert.match(buildKimiCommand(pinned), /--model'? '?pinned-model/);
  for (const build of [buildCodexCommand, buildClaudeCommand, buildPiCommand, buildKimiCommand]) {
    assert.doesNotMatch(build(pinned), /env-(openai|claude|pi|kimi)/);
  }
}));

test("without a pinned model the env default still applies", () => withEnv(MANAGED_ENV, () => {
  const state = initialAgentState("task");
  assert.match(buildCodexCommand(state), /env-openai/);
  assert.match(buildClaudeCommand(state), /env-claude/);
}));

test("a local node honors a pinned model but not the daemon's env default", () => withEnv(
  { ...MANAGED_ENV, RELAY_RUN_AS_CURRENT_USER: "1", RELAY_AGENT_HOME: "/user/home" },
  () => {
    assert.match(buildClaudeCommand(pinned), /pinned-model/);
    assert.match(buildCodexCommand(pinned), /pinned-model/);
    assert.doesNotMatch(buildClaudeCommand(initialAgentState("task")), /env-claude/);
  },
));

test("kimi configured through KIMI_MODEL_* takes the pinned model as KIMI_MODEL_NAME", () => withEnv(
  { KIMI_MODEL_NAME: "env-kimi-name", KIMI_MODEL_API_KEY: "key" },
  () => {
    const command = buildKimiCommand(pinned);
    assert.match(command, /export KIMI_MODEL_NAME='?pinned-model'?/);
    assert.doesNotMatch(command, /--model/);
  },
));

const LOCAL = { RELAY_RUN_AS_CURRENT_USER: "1", RELAY_AGENT_HOME: "/user/home" };

test("a local kimi node passes the pin as --model when only the daemon's shell has KIMI_API_KEY", () => withEnv(
  { ...LOCAL, KIMI_API_KEY: "daemon-key" },
  () => {
    // The run never receives KIMI_API_KEY, so KIMI_MODEL_NAME would be ignored.
    const command = buildKimiCommand(pinned);
    assert.match(command, /--model'? '?pinned-model/);
    assert.doesNotMatch(command, /KIMI_MODEL_NAME/);
  },
));

test("a local kimi node configured through KIMI_MODEL_* still pins via KIMI_MODEL_NAME", () => withEnv(
  { ...LOCAL, KIMI_MODEL_API_KEY: "key", KIMI_MODEL_NAME: "user-model" },
  () => {
    const command = buildKimiCommand(pinned);
    assert.match(command, /export KIMI_MODEL_NAME='?pinned-model'?/);
    assert.doesNotMatch(command, /--model/);
  },
));

test("pi keeps the node's provider for a bare pin but not for a provider-qualified one", () => withEnv(
  { PI_PROVIDER: "anthropic", PI_MODEL: "env-pi", PI_API_KEY: "key" },
  () => {
    assert.match(buildPiCommand(pinned), /--provider'? '?anthropic/);
    const qualified = buildPiCommand({ ...pinned, agent_model: "openai/gpt-5" });
    assert.doesNotMatch(qualified, /--provider/);
    assert.match(qualified, /--model'? '?openai\/gpt-5/);
  },
));

test("a local pi node never forces a provider, so a qualified pin behaves as on a managed node", () => withEnv(
  { ...LOCAL, PI_PROVIDER: "anthropic" },
  () => {
    const command = buildPiCommand({ ...pinned, agent_model: "openai/gpt-5" });
    assert.doesNotMatch(command, /--provider/);
    assert.match(command, /--model'? '?openai\/gpt-5/);
  },
));

test("codex behind a custom endpoint gets the pin as -m and no env model override", () => withEnv(
  { OPENAI_BASE_URL: "https://dashscope.example/v1", OPENAI_MODEL: "env-openai", OPENAI_API_KEY: "key" },
  () => {
    const command = buildCodexCommand(pinned);
    assert.match(command, /'-m' 'pinned-model'|-m pinned-model/);
    assert.doesNotMatch(command, /env-openai/);
    assert.match(command, /dashscope/);
  },
));

test("custom model endpoints are reported for the runtimes whose base URL is overridden", () => {
  withEnv({ OPENAI_BASE_URL: "https://proxy.example/v1" }, () => {
    assert.deepEqual(customModelEndpointAgents(), ["codex"]);
  });
  withEnv({ ...LOCAL, ANTHROPIC_BASE_URL: "https://proxy.example" }, () => {
    assert.deepEqual(customModelEndpointAgents(), ["claude"]);
  });
  withEnv({}, () => {
    assert.deepEqual(customModelEndpointAgents(), []);
  });
});
