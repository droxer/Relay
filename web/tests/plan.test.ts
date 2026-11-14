import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { agentLabel, parsePlanSteps } from "../src/lib/plan.js";

const AGENTS = ["claude", "pi", "codex", "opencode"] as const;

describe("parsePlanSteps", () => {
  it("parses a multi-step assignment plan", () => {
    const body = JSON.stringify({
      assignments: [
        { agent: "claude" },
        { agent: "codex" },
      ],
    });
    assert.deepEqual(parsePlanSteps(body, AGENTS), [
      { agent: "claude" },
      { agent: "codex" },
    ]);
  });

  it("parses a single adaptive assignment", () => {
    const body = JSON.stringify({ assignments: [{ agent: "pi" }] });
    assert.deepEqual(parsePlanSteps(body, AGENTS), [{ agent: "pi" }]);
  });

  it("drops entries with an unknown agent", () => {
    const body = JSON.stringify({
      assignments: [
        { agent: "ghost" },
        { agent: "opencode" },
      ],
    });
    assert.deepEqual(parsePlanSteps(body, AGENTS), [{ agent: "opencode" }]);
  });

  it("returns null for non-plan / invalid JSON", () => {
    assert.equal(parsePlanSteps("not json", AGENTS), null);
    assert.equal(parsePlanSteps(JSON.stringify({ assignments: [] }), AGENTS), null);
    assert.equal(parsePlanSteps(JSON.stringify({ foo: "bar" }), AGENTS), null);
  });
});

describe("agentLabel", () => {
  it("capitalizes the agent name", () => {
    assert.equal(agentLabel("claude"), "Claude");
    assert.equal(agentLabel("codex"), "Codex");
  });
});
