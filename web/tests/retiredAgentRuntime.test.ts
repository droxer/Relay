import assert from "node:assert/strict";
import { test } from "node:test";
import { AGENT_NAMES } from "../src/types.js";
import type { AgentName } from "../src/types.js";
import { agentCheckpoints, parseAgentStream } from "../src/lib/agent-stream/parse.js";

test("retired runtimes are absent from the UI and historical logs remain readable", () => {
  assert.equal(AGENT_NAMES.some((name: string) => name === "kimi"), false);
  const retired = "kimi" as AgentName;
  const raw = '{"role":"assistant","content":"historical output"}\n';
  assert.deepEqual(parseAgentStream(retired, raw), [{ kind: "text", text: raw.trimEnd() }]);
  assert.deepEqual(agentCheckpoints(retired, raw, 0), []);
});
