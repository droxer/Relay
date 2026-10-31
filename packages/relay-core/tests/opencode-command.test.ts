import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildOpenCodeCommand, formatOpenCodeJsonLine, getAgent, initialAgentState, OpenCodeStreamRenderer, type AgentState } from "../src/index.js";

function withEnv(env: Record<string, string>, action: () => void): void {
  const previous = process.env;
  process.env = { PATH: previous.PATH, ...env };
  try { action(); } finally { process.env = previous; }
}

const LOCAL = { RELAY_RUN_AS_CURRENT_USER: "1", RELAY_AGENT_HOME: "/user/home" };
const openCodeLaunch = {
  adapter: "opencode-acp" as const,
  command: "/usr/local/bin/node",
  args: ["/opt/relay/dist/permission-adapters/opencode-acp.js"],
  env: { RELAY_PERMISSION_FILE: "/tmp/relay-perm-x/broker.json" },
};
const plain = (): AgentState => initialAgentState("task");
const prompted = (overrides: Partial<AgentState> = {}): AgentState => ({ ...plain(), permission_prompt: openCodeLaunch, ...overrides });

describe("buildOpenCodeCommand", () => {
  it("runs the ACP adapter for a native local run with an opencode-acp launch", () => withEnv(LOCAL, () => {
    const command = buildOpenCodeCommand(prompted(), "/work/space");
    assert.match(command, /export RELAY_PERMISSION_FILE=\/tmp\/relay-perm-x\/broker\.json && /);
    assert.match(command, /\/usr\/local\/bin\/node \/opt\/relay\/dist\/permission-adapters\/opencode-acp\.js --cwd \/work\/space /);
    assert.match(command, / --prompt /);
    // The adapter replaces `opencode run`, which would hang on a tool that asks.
    assert.doesNotMatch(command, /opencode run|--auto/);
  }));

  it("passes a pinned model to the adapter", () => withEnv(LOCAL, () => {
    const command = buildOpenCodeCommand(prompted({ agent_model: "deepseek/deepseek-flash" }), "/work/space");
    assert.match(command, /--model deepseek\/deepseek-flash/);
  }));

  it("refuses a native local run that has no adapter, rather than running headless", () => withEnv(LOCAL, () => {
    assert.throws(() => buildOpenCodeCommand(plain(), "/work/space"), /permission adapter is not attached/);
    // Another runtime's adapter does not count.
    assert.throws(
      () => buildOpenCodeCommand({ ...plain(), permission_prompt: { ...openCodeLaunch, adapter: "kimi-acp" as const } }, "/work/space"),
      /permission adapter is not attached/,
    );
  }));

  it("runs headless with --auto for trusted local and BoxLite runs, ignoring the launch", () => {
    withEnv({ ...LOCAL, RELAY_LOCAL_PERMISSION_POLICY: "trusted" }, () => {
      const command = buildOpenCodeCommand(prompted(), "/work/space");
      assert.match(command, /opencode run --format json --auto -- /);
      assert.doesNotMatch(command, /opencode-acp/);
    });
    withEnv({}, () => {
      const command = buildOpenCodeCommand(prompted(), "/work/space");
      assert.match(command, /opencode run --format json --auto -- /);
    });
  });

  it("is registered with the ACP adapter", () => {
    assert.deepEqual(getAgent("opencode").permissionPrompts, { kind: "adapter", adapter: "opencode-acp" });
  });
});

describe("OpenCodeStreamRenderer", () => {
  it("streams deltas as one block with whitespace intact", () => {
    const renderer = new OpenCodeStreamRenderer();
    const output = ["Hello", " ", "world."]
      .map((text) => renderer.feed(`${JSON.stringify({ type: "text", delta: true, part: { type: "text", text } })}\n`))
      .join("").replace(/\x1b\[[0-9;]*m/g, "");
    assert.match(output, /Hello world\./);
    assert.equal(output.split("●").length - 1, 1);
  });

  it("renders assistant text and completed tool calls without printing raw JSON", () => {
    const renderer = new OpenCodeStreamRenderer();
    const output = [
      { type: "step_start", part: { type: "step-start" } },
      { type: "text", part: { type: "text", text: "Working on it." } },
      { type: "tool_use", part: { tool: "shell", state: { status: "completed", title: "echo hi", output: "hi\n" } } },
      { type: "step_finish", part: { type: "step-finish", tokens: { input: 3, output: 1 } } },
    ].map((event) => renderer.feed(`${JSON.stringify(event)}\n`)).join("");

    assert.match(output, /Working on it\./);
    assert.match(output, /echo hi/);
    assert.doesNotMatch(output, /"type"|step_start|step-finish/);
  });

  it("shows a failed turn as an error line", () => {
    const line = JSON.stringify({ type: "error", error: { message: "Provider request failed with HTTP 400" } });
    assert.match(formatOpenCodeJsonLine(line), /OpenCode error: Provider request failed with HTTP 400/);
  });

  it("keeps non-JSON lines as sanitized text instead of dropping them", () => {
    assert.match(formatOpenCodeJsonLine("plain words"), /plain words/);
  });
});
