import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { RelayApiError } from "../src/api.js";
import {
  agentReadiness,
  dispatchReadyAgents,
  formatDispatchError,
  isAgentDispatchReady,
} from "../src/lib/agentReadiness.js";

describe("Relay web agent readiness", () => {
  const node = {
    agents: { claude: "unknown", pi: "ready", codex: "failed", kimi: "ready", opencode: "unknown" } as const,
    disabledAgents: ["kimi" as const],
  };

  it("treats only ready, enabled agents as dispatchable", () => {
    assert.equal(agentReadiness(node, "claude"), "unknown");
    assert.equal(agentReadiness(node, "pi"), "ready");
    assert.equal(agentReadiness(node, "codex"), "failed");
    assert.equal(agentReadiness(node, "kimi"), "disabled");
    assert.deepEqual(dispatchReadyAgents(node, ["claude", "pi", "codex", "kimi"]), ["pi"]);
    const why = { agents: { claude: "unavailable", pi: "unresponsive", codex: "failed", kimi: "ready", opencode: "unknown" } as const };
    assert.equal(agentReadiness(why, "claude"), "unavailable");
    assert.equal(agentReadiness(why, "pi"), "unresponsive");
    assert.deepEqual(dispatchReadyAgents(why, ["claude", "pi", "codex", "kimi"]), ["kimi"]);
    assert.equal(isAgentDispatchReady(node, "claude"), false);
    assert.equal(isAgentDispatchReady(node, "pi"), true);
  });

  it("formats backend not-ready dispatch errors", () => {
    const message = formatDispatchError(
      new RelayApiError("Sandbox sbx_alice daemon node does not have ready agent(s): claude.", 400),
      ((key: string, vars?: { agent?: string }) => `${key}:${vars?.agent ?? ""}`) as never,
    );
    assert.equal(message, "errors.agent_not_ready:claude");
  });

  it("formats workspace placement errors with the affected agent", () => {
    const message = formatDispatchError(
      new RelayApiError(
        "Agent Hawkeye has no eligible runtime placement (workspace_unavailable).",
        409,
      ),
      ((key: string, vars?: { agent?: string }) => `${key}:${vars?.agent ?? ""}`) as never,
    );
    assert.equal(message, "errors.workspace_unavailable:Hawkeye");
  });

  // Every placement rejection arrives in the same sentence with a different
  // code. Reporting them all as a connection problem sends the reader after
  // the wrong thing — a busy node is healthy, it just has no free slot.
  it("formats each placement rejection code with its own message", () => {
    const t = ((key: string, vars?: { agent?: string }) => `${key}:${vars?.agent ?? ""}`) as never;
    const cases: Array<[string, string]> = [
      ["capacity_exhausted", "errors.capacity_exhausted:Hawkeye"],
      ["node_offline", "errors.node_offline:Hawkeye"],
      ["executor_not_ready", "errors.executor_not_ready:Hawkeye"],
      ["agent_configuration_pending", "errors.agent_configuration_pending:Hawkeye"],
    ];
    for (const [code, expected] of cases) {
      assert.equal(
        formatDispatchError(
          new RelayApiError(`Agent Hawkeye has no eligible runtime placement (${code}).`, 409),
          t,
        ),
        expected,
      );
    }
  });

  it("leaves an unknown placement code to the caller's generic message", () => {
    assert.equal(
      formatDispatchError(
        new RelayApiError("Agent Hawkeye has no eligible runtime placement (meteor_strike).", 409),
        ((key: string) => key) as never,
      ),
      undefined,
    );
  });
});
