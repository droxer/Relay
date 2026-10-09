import assert from "node:assert/strict";
import { test } from "node:test";
import { buildClaudeCommand, buildCodexCommand, buildKimiCommand, buildPiCommand, initialAgentState } from "../src/index.js";

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
