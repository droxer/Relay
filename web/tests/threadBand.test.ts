import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { threadAgentName, threadBandFacts } from "../src/lib/threadBand.js";
import type { RelaySession } from "../src/types.js";

function session(overrides: Partial<RelaySession> = {}): RelaySession {
  return {
    id: "session-1",
    workspacePath: "/workspace",
    taskGoal: "Ship the thing",
    participants: [],
    status: "idle",
    phase: "idle",
    createdAt: "2026-09-01T00:00:00Z",
    updatedAt: "2026-09-02T00:00:00Z",
    agentRuns: [],
    artifacts: [],
    ...overrides,
  } as RelaySession;
}

describe("threadBandFacts", () => {
  it("always reports when the thread last moved", () => {
    const facts = threadBandFacts(session(), {});
    assert.deepEqual(facts.map((fact) => fact.key), ["updated"]);
    assert.deepEqual(facts[0], { key: "updated", iso: "2026-09-02T00:00:00Z" });
  });

  it("names the project a thread belongs to, so the thread can lead back to it", () => {
    const facts = threadBandFacts(session({ projectId: "p1" }), { projectName: "Apollo" });
    assert.deepEqual(facts[0], { key: "project", projectId: "p1", name: "Apollo" });
  });

  it("falls back to the project id rather than dropping the fact", () => {
    const facts = threadBandFacts(session({ projectId: "p1" }), {});
    assert.deepEqual(facts[0], { key: "project", projectId: "p1", name: "p1" });
  });

  it("omits the project entirely for a solo thread", () => {
    const facts = threadBandFacts(session(), { projectName: "Apollo" });
    assert.ok(!facts.some((fact) => fact.key === "project"));
  });

  it("names the agent and the computer when the thread has them", () => {
    const facts = threadBandFacts(
      session({ computerId: "device:employee-1:main" }),
      { agentName: "Ada", computerName: "Studio" },
    );
    assert.deepEqual(facts.map((fact) => fact.key), ["agent", "computer", "updated"]);
    assert.deepEqual(facts[1], { key: "computer", id: "device:employee-1:main", name: "Studio" });
  });

  it("falls back to the computer id when no display name resolves", () => {
    const facts = threadBandFacts(session({ computerId: "device:employee-1:main" }), {});
    assert.deepEqual(
      facts.find((fact) => fact.key === "computer"),
      { key: "computer", id: "device:employee-1:main", name: "device:employee-1:main" },
    );
  });
});

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
