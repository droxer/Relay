import assert from "node:assert/strict";
import { test } from "node:test";
import { AGENT_NAMES, isAgentName } from "../src/agents.js";

test("only supported runtimes are advertised and retired runtimes are rejected", () => {
  assert.deepEqual(AGENT_NAMES, ["claude", "pi", "codex", "opencode"]);
  assert.equal(isAgentName("kimi"), false);
});
