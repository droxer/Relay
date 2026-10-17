import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildPiCommand, initialAgentState, type AgentState } from "../src/index.js";

function withEnv(env: Record<string, string>, action: () => void): void {
  const previous = process.env;
  process.env = { PATH: previous.PATH, ...env };
  try { action(); } finally { process.env = previous; }
}

const LOCAL = { RELAY_RUN_AS_CURRENT_USER: "1", RELAY_AGENT_HOME: "/user/home" };
const SCRIPT = "/opt/relay/dist/permission-adapters/pi-extension.js";
const piLaunch = {
  adapter: "pi-extension" as const,
  command: "/usr/local/bin/node",
  args: [SCRIPT],
  env: { RELAY_PERMISSION_SOCKET: "/tmp/relay-perm-x/broker.sock", RELAY_PERMISSION_SECRET: "s3cret" },
};
const plain = (): AgentState => initialAgentState("task");
const prompted = (overrides: Partial<AgentState> = {}): AgentState => ({ ...plain(), permission_prompt: piLaunch, ...overrides });

/** The three pi invocations of the fallback chain: json, -P, -p. */
function piVariants(command: string): string[] {
  const chain = command.slice(command.indexOf("if pi --help"));
  // The prompt spans lines, so each capture runs to the next shell keyword.
  return [/^if [^;]*; then (pi [\s\S]*?); elif pi --help/, /elif pi --help[^;]*; then (pi [\s\S]*?); else pi /, /; else (pi [\s\S]*?); fi$/].map((pattern) => {
    const match = chain.match(pattern);
    assert.ok(match, `${pattern} in ${chain}`);
    return match[1];
  });
}

describe("buildPiCommand with the Pi extension adapter", () => {
  it("loads the extension in every fallback command and exports the broker env ahead of them", () => withEnv(LOCAL, () => {
    const command = buildPiCommand(prompted(), "/work/space");
    assert.match(command, /^export HOME=.* && cd \/work\/space && export RELAY_PERMISSION_SOCKET=\/tmp\/relay-perm-x\/broker\.sock && export RELAY_PERMISSION_SECRET=s3cret && if pi --help/);
    const variants = piVariants(command);
    assert.equal(variants.length, 3);
    for (const variant of variants) assert.match(variant, new RegExp(`^pi --no-session --extension ${SCRIPT} `));
    assert.match(variants[0], / --mode json /);
    assert.match(variants[1], / -P /);
    assert.match(variants[2], / -p /);
    // The extension is loaded by pi, never run by node.
    assert.doesNotMatch(command, /\/usr\/local\/bin\/node/);
  }));

  it("keeps the extension ahead of the skill flags and model options", () => withEnv(LOCAL, () => {
    const command = buildPiCommand(prompted({ skill_paths: ["/skills/a"], agent_model: "pinned" }), "/w");
    for (const variant of piVariants(command)) {
      assert.match(variant, new RegExp(`^pi --no-session --extension ${SCRIPT} --no-skills --skill /skills/a --model pinned `));
    }
  }));

  it("is byte-for-byte the plain command without a launch or with another adapter's", () => withEnv(LOCAL, () => {
    const expected = buildPiCommand(plain(), "/work/space");
    assert.doesNotMatch(expected, /--extension|RELAY_PERMISSION/);
    for (const variant of piVariants(expected)) assert.match(variant, /^pi --no-session /);
    const claudeLaunch = { ...piLaunch, adapter: "claude-mcp" as const };
    assert.equal(buildPiCommand({ ...plain(), permission_prompt: claudeLaunch }, "/work/space"), expected);
  }));

  it("ignores the launch for trusted local and BoxLite runs", () => {
    withEnv({ ...LOCAL, RELAY_LOCAL_PERMISSION_POLICY: "trusted" }, () => {
      const command = buildPiCommand(prompted(), "/work/space");
      assert.equal(command, buildPiCommand(plain(), "/work/space"));
      assert.doesNotMatch(command, /--extension|RELAY_PERMISSION/);
    });
    withEnv({}, () => {
      const command = buildPiCommand(prompted(), "/workspace");
      assert.equal(command, buildPiCommand(plain(), "/workspace"));
      assert.doesNotMatch(command, /--extension|RELAY_PERMISSION/);
      assert.match(command, /stdbuf -oL -eL pi --no-session /);
    });
  });
});
