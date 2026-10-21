import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildKimiCommand, initialAgentState, type AgentState } from "../src/index.js";

function withEnv(env: Record<string, string>, action: () => void): void {
  const previous = process.env;
  process.env = { PATH: previous.PATH, ...env };
  try { action(); } finally { process.env = previous; }
}

const LOCAL = { RELAY_RUN_AS_CURRENT_USER: "1", RELAY_AGENT_HOME: "/user/home" };
const kimiLaunch = {
  adapter: "kimi-acp" as const,
  command: "/usr/local/bin/node",
  args: ["/opt/relay/dist/permission-adapters/kimi-acp.js"],
  env: { RELAY_PERMISSION_FILE: "/tmp/relay-perm-x/broker.json" },
};
const plain = (): AgentState => initialAgentState("task");
const prompted = (overrides: Partial<AgentState> = {}): AgentState => ({ ...plain(), permission_prompt: kimiLaunch, ...overrides });

describe("buildKimiCommand", () => {
  it("runs the ACP adapter for a native local run with a kimi-acp launch", () => withEnv(LOCAL, () => {
    const command = buildKimiCommand(prompted(), "/work/space");
    assert.match(command, /export RELAY_PERMISSION_FILE=\/tmp\/relay-perm-x\/broker\.json && /);
    assert.match(command, /\/usr\/local\/bin\/node \/opt\/relay\/dist\/permission-adapters\/kimi-acp\.js --cwd \/work\/space /);
    assert.match(command, / --prompt /);
    assert.match(command, /^export HOME=.* && cd \/work\/space && /);
    // The adapter replaces `kimi -p`; it never runs in Never Ask mode.
    assert.doesNotMatch(command, /--output-format|--auto|kimi --/);
  }));

  it("keeps the plain `kimi -p` command without a launch or with another adapter's", () => withEnv(LOCAL, () => {
    const expected = buildKimiCommand(plain(), "/work/space");
    assert.match(expected, /kimi --output-format stream-json --prompt /);
    const claudeLaunch = { ...kimiLaunch, adapter: "claude-mcp" as const };
    assert.equal(buildKimiCommand({ ...plain(), permission_prompt: claudeLaunch }, "/work/space"), expected);
  }));

  it("ignores the launch for trusted local and BoxLite runs", () => {
    withEnv({ ...LOCAL, RELAY_LOCAL_PERMISSION_POLICY: "trusted" }, () => {
      const command = buildKimiCommand(prompted(), "/work/space");
      assert.equal(command, buildKimiCommand(plain(), "/work/space"));
      assert.match(command, /kimi --auto --output-format stream-json/);
    });
    withEnv({}, () => {
      const command = buildKimiCommand(prompted(), "/workspace");
      assert.equal(command, buildKimiCommand(plain(), "/workspace"));
      assert.match(command, /kimi --auto /);
    });
  });

  it("passes a pinned model as --model, or through KIMI_MODEL_NAME when the env configures the model", () => {
    withEnv(LOCAL, () => {
      const command = buildKimiCommand(prompted({ agent_model: "kimi-code/k3" }), "/w");
      assert.match(command, / --model kimi-code\/k3 --prompt /);
      assert.doesNotMatch(command, /KIMI_MODEL_NAME/);
    });
    withEnv({ ...LOCAL, KIMI_MODEL_API_KEY: "key", KIMI_MODEL_NAME: "base" }, () => {
      const command = buildKimiCommand(prompted({ agent_model: "pinned" }), "/w");
      assert.match(command, /export KIMI_MODEL_NAME=pinned && /);
      assert.doesNotMatch(command, /--model/);
    });
  });

  it("carries assigned skills in the prompt, since ACP takes no --skills-dir", () => withEnv(LOCAL, () => {
    const command = buildKimiCommand(prompted({ skill_paths: ["/skills/review"] }), "/w");
    assert.doesNotMatch(command, /--skills-dir/);
    assert.match(command, /\[Assigned skills\]/);
    assert.match(command, /\/skills\/review\/SKILL\.md/);
    // `kimi -p` keeps its native flag.
    assert.match(buildKimiCommand({ ...plain(), skill_paths: ["/skills/review"] }, "/w"), /--skills-dir \/skills\/review/);
  }));
});
