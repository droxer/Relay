import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { threadAgentName } from "../src/lib/threadBand.js";
import type { RelaySession } from "../src/types.js";

describe("threadAgentName", () => {
  const names = { "agent-analyst": "Analyst", "agent-builder": "Builder" };
  const run = (logicalAgentId?: string): RelaySession["agentRuns"][number] =>
    ({ id: "r", agent: "codex", logicalAgentId, status: "running", startedAt: "2026-09-23T00:00:00Z", artifactIds: [] });

  it("names the agent that ran the thread, not the composer's selection", () => {
    // The regression: the composer fell back to Builder because Analyst was
    // not routable, and the band relabelled Analyst's transcript as Builder's.
    assert.equal(threadAgentName({ agentRuns: [run("agent-analyst")] }, "Builder", names), "Analyst");
  });

  it("follows the latest run when several agents took turns", () => {
    assert.equal(threadAgentName({ agentRuns: [run("agent-builder"), run("agent-analyst")] }, "Builder", names), "Analyst");
  });

  it("falls back to the composer's selection for a thread with no runs yet", () => {
    assert.equal(threadAgentName({ agentRuns: [] }, "Builder", names), "Builder");
  });

  it("labels a legacy run with no logical id by its executor", () => {
    assert.equal(threadAgentName({ agentRuns: [run(undefined)] }, "Builder", names, { codex: "Codex" }), "Codex");
  });
});
