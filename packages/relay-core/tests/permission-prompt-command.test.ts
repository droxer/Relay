import assert from "node:assert/strict";
import { test } from "node:test";
import { AGENT_NAMES, buildClaudeCommand, buildCodexCommand, buildKimiCommand, buildPiCommand, getAgent, initialAgentState } from "../src/index.js";

function withEnv(env: Record<string, string>, action: () => void): void {
  const previous = process.env;
  process.env = { PATH: previous.PATH, ...env };
  try { action(); } finally { process.env = previous; }
}

const LOCAL = { RELAY_RUN_AS_CURRENT_USER: "1", RELAY_AGENT_HOME: "/user/home" };
const launch = {
  adapter: "claude-mcp" as const,
  command: "/usr/local/bin/node",
  args: ["/opt/relay/dist/permission-prompt-server.js"],
  env: { RELAY_PERMISSION_FILE: "/tmp/relay-perm-x/broker.json" },
};
const prompted = { ...initialAgentState("task"), permission_prompt: launch };

/** Reads the single shell word that follows `flag` in a shellCommand string. */
function shellWordAfter(command: string, flag: string): string | undefined {
  const start = command.indexOf(`${flag} `);
  if (start < 0) return undefined;
  const rest = command.slice(start + flag.length + 1);
  if (!rest.startsWith("'")) return rest.split(" ")[0];
  let word = "";
  let index = 1;
  while (index < rest.length) {
    if (rest.startsWith("'\\''", index)) {
      word += "'";
      index += 4;
    } else if (rest[index] === "'") {
      return word;
    } else {
      word += rest[index++];
    }
  }
  return undefined;
}

test("a native local Claude run routes permission prompts to Relay's MCP server", () => withEnv(LOCAL, () => {
  const command = buildClaudeCommand(prompted);
  assert.equal(shellWordAfter(command, "--permission-prompt-tool"), "mcp__relay__approve");
  const config = JSON.parse(shellWordAfter(command, "--mcp-config") ?? "null");
  assert.deepEqual(config, {
    mcpServers: { relay: { type: "stdio", command: launch.command, args: launch.args, env: launch.env } },
  });
  assert.doesNotMatch(command, /bypassPermissions/);
  // The variadic --mcp-config is closed by --add-dir before the prompt.
  assert.ok(command.indexOf("--mcp-config") < command.indexOf("--add-dir"));
}));

test("native local Claude without a broker keeps its plain headless command", () => withEnv(LOCAL, () => {
  const command = buildClaudeCommand(initialAgentState("task"));
  assert.doesNotMatch(command, /--permission-prompt-tool|--mcp-config/);
}));

test("trusted local and BoxLite Claude runs never add a permission prompt", () => {
  withEnv({ ...LOCAL, RELAY_LOCAL_PERMISSION_POLICY: "trusted" }, () => {
    const command = buildClaudeCommand(prompted);
    assert.doesNotMatch(command, /--permission-prompt-tool|--mcp-config/);
    assert.match(command, /bypassPermissions/);
  });
  withEnv({}, () => {
    const command = buildClaudeCommand(prompted);
    assert.doesNotMatch(command, /--permission-prompt-tool|--mcp-config/);
    assert.match(command, /bypassPermissions/);
  });
});

test("other runtimes ignore another adapter's launch", () => withEnv(LOCAL, () => {
  for (const build of [buildCodexCommand, buildPiCommand, buildKimiCommand]) {
    assert.equal(build(prompted), build(initialAgentState("task")));
  }
  const codexLaunch = { ...launch, adapter: "codex-app-server" as const, args: ["/opt/relay/dist/codex-app-server.js"] };
  const codexState = { ...initialAgentState("task"), permission_prompt: codexLaunch };
  assert.equal(buildClaudeCommand(codexState), buildClaudeCommand(initialAgentState("task")));
}));

const codexLaunch = {
  adapter: "codex-app-server" as const,
  command: "/usr/local/bin/node",
  args: ["/opt/relay/dist/permission-adapters/codex-app-server.js"],
  env: { RELAY_PERMISSION_FILE: "/tmp/relay-perm-x/broker.json" },
};
const codexPrompted = { ...initialAgentState("task"), permission_prompt: codexLaunch, agent_model: "gpt-pinned", resume_session_id: "01a1479f-47fd-75c3-8178-9c48c983d4e0" };

test("a native local Codex run goes through the app-server adapter instead of codex exec", () => withEnv(LOCAL, () => {
  const command = buildCodexCommand(codexPrompted, "/work/space");
  assert.match(command, /export RELAY_PERMISSION_FILE=\/tmp\/relay-perm-x\/broker\.json && /);
  assert.match(command, /\/usr\/local\/bin\/node \/opt\/relay\/dist\/permission-adapters\/codex-app-server\.js --cwd \/work\/space --model gpt-pinned --resume 01a1479f-47fd-75c3-8178-9c48c983d4e0 -- '/);
  assert.doesNotMatch(command, /codex'? exec|--dangerously-bypass/);
  assert.match(command, /< \/dev\/null$/);
}));

test("Codex keeps codex exec byte-for-byte without its adapter, and under trusted or BoxLite", () => {
  withEnv(LOCAL, () => {
    const plain = { ...codexPrompted, permission_prompt: undefined };
    assert.equal(buildCodexCommand({ ...codexPrompted, permission_prompt: launch }, "/w"), buildCodexCommand(plain, "/w"));
    assert.match(buildCodexCommand(plain, "/w"), /codex .*exec resume --json/);
  });
  for (const env of [{ ...LOCAL, RELAY_LOCAL_PERMISSION_POLICY: "trusted" }, {}]) {
    withEnv(env, () => {
      const plain = { ...codexPrompted, permission_prompt: undefined };
      assert.equal(buildCodexCommand(codexPrompted, "/w"), buildCodexCommand(plain, "/w"));
      assert.match(buildCodexCommand(codexPrompted, "/w"), /--dangerously-bypass-approvals-and-sandbox/);
    });
  }
});

test("every runtime declares a permission prompt adapter", () => {
  for (const name of AGENT_NAMES) assert.equal(getAgent(name).permissionPrompts.kind, "adapter", name);
  assert.deepEqual(getAgent("claude").permissionPrompts, { kind: "adapter", adapter: "claude-mcp" });
  assert.deepEqual(getAgent("codex").permissionPrompts, { kind: "adapter", adapter: "codex-app-server" });
  assert.deepEqual(getAgent("kimi").permissionPrompts, { kind: "adapter", adapter: "kimi-acp" });
  assert.deepEqual(getAgent("pi").permissionPrompts, { kind: "adapter", adapter: "pi-extension" });
});

/** The `--allowedTools` rules up to the next flag. */
function allowedToolRules(command: string): string[] {
  const start = command.indexOf("--allowedTools ");
  if (start < 0) return [];
  const rest = command.slice(start + "--allowedTools ".length);
  return rest.slice(0, rest.indexOf("--add-dir")).trim().split(" ").map((word) => word.replace(/^'|'$/g, ""));
}

const reporting = {
  ...initialAgentState("task"),
  skill_paths: ["/Users/ada/.relay/managed-skills/views/v1/skills/karpathy"],
  round_result_file: ".relay/round-result.json",
};

test("a native local Claude run may read its skills and write its report without asking", () => withEnv(LOCAL, () => {
  const command = buildClaudeCommand(reporting, "/Users/ada/work/");
  assert.deepEqual(allowedToolRules(command), [
    "Read(//Users/ada/.relay/managed-skills/views/v1/skills/karpathy/**)",
    "Edit(//Users/ada/work/.relay/round-result.json)",
  ]);
  // The variadic --allowedTools is closed by --add-dir before the prompt.
  assert.ok(command.indexOf("--allowedTools") < command.indexOf("--add-dir"));
}));

test("Windows paths keep their drive in Claude's root-anchored rule form", () => withEnv(LOCAL, () => {
  const command = buildClaudeCommand({ ...reporting, skill_paths: ["C:\\Users\\ada\\skills\\x"] }, "C:\\work");
  assert.deepEqual(allowedToolRules(command), ["Read(//C:/Users/ada/skills/x/**)", "Edit(//C:/work/.relay/round-result.json)"]);
}));

test("a relative Relay path is refused rather than anchored at the wrong root", () => withEnv(LOCAL, () => {
  assert.throws(() => buildClaudeCommand({ ...reporting, skill_paths: ["skills/x"] }, "/w"), /must be absolute/);
}));

test("a run with nothing of Relay's to touch, or one that bypasses permissions, adds no rules", () => {
  withEnv(LOCAL, () => assert.doesNotMatch(buildClaudeCommand(initialAgentState("task"), "/w"), /--allowedTools/));
  withEnv({ ...LOCAL, RELAY_LOCAL_PERMISSION_POLICY: "trusted" }, () => assert.doesNotMatch(buildClaudeCommand(reporting, "/w"), /--allowedTools/));
  withEnv({}, () => assert.doesNotMatch(buildClaudeCommand(reporting, "/w"), /--allowedTools/));
});
