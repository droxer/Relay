import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { deriveTeamHandoff } from "../src/lib/teamHandoff.js";
import type { RelaySession } from "../src/types.js";

type Run = RelaySession["agentRuns"][number];

function run(id: string, assignmentId: string, agentId: string, patch: Partial<Run> = {}): Run {
  return {
    id,
    assignmentId,
    agent: "claude",
    logicalAgentId: agentId,
    status: "completed",
    startedAt: "2026-09-27T10:00:00Z",
    completedAt: "2026-09-27T10:01:00Z",
    artifactIds: [],
    ...patch,
  } as Run;
}

function session(
  runs: Run[],
  style: "build_review" | "pipeline" | "lead_led" = "pipeline",
  status: RelaySession["status"] = "running",
): RelaySession {
  return {
    id: "s",
    status,
    activeRoundId: "r",
    agentRuns: runs,
    collaborationRounds: [{
      roundId: "r",
      style,
      assignments: [
        { assignmentId: "a1", agentId: "ada", role: "implementer" },
        { assignmentId: "a2", agentId: "rex", role: "reviewer" },
      ],
    }],
  } as unknown as RelaySession;
}

describe("deriveTeamHandoff", () => {
  it("names the next teammate in the gap after a member finishes", () => {
    const handoff = deriveTeamHandoff(session([run("r1", "a1", "ada")]));
    assert.deepEqual(handoff, {
      fromAgentId: "ada",
      fromAgent: "claude",
      toAgentId: "rex",
      since: "2026-09-27T10:01:00Z",
    });
  });

  it("stays quiet while a member is still running", () => {
    assert.equal(deriveTeamHandoff(session([run("r1", "a1", "ada", { status: "running" })])), null);
  });

  it("stays quiet once the next member's run has started", () => {
    const runs = [run("r1", "a1", "ada"), run("r2", "a2", "rex", { status: "running" })];
    assert.equal(deriveTeamHandoff(session(runs)), null);
  });

  it("stays quiet when the thread is no longer running", () => {
    assert.equal(deriveTeamHandoff(session([run("r1", "a1", "ada")], "pipeline", "waiting_for_human")), null);
  });

  it("stays quiet after a failed member", () => {
    assert.equal(deriveTeamHandoff(session([run("r1", "a1", "ada", { status: "failed" })])), null);
  });

  it("stays quiet for a single-member round", () => {
    const s = session([run("r1", "a1", "ada")]);
    const round = s.collaborationRounds![0]!;
    s.collaborationRounds = [{ ...round, assignments: round.assignments.slice(0, 1) }];
    assert.equal(deriveTeamHandoff(s), null);
  });

  it("routes a reviewer's change request back to the builder", () => {
    const runs = [
      run("r1", "a1", "ada"),
      run("r2", "a2", "rex", { workResult: { status: "continue", evidence: [], findings: [{ workItemId: "w", note: "fix" }] } }),
    ];
    assert.equal(deriveTeamHandoff(session(runs, "build_review"))?.toAgentId, "ada");
  });

  it("leaves the target open when the last assignment has finished", () => {
    const runs = [run("r1", "a1", "ada"), run("r2", "a2", "rex", { workResult: { status: "done", evidence: [] } })];
    assert.equal(deriveTeamHandoff(session(runs, "build_review"))?.toAgentId, null);
  });

  it("ignores consultations when picking who spoke last", () => {
    const runs = [run("r1", "a1", "ada"), run("r2", "a2", "rex", { consultation: true })];
    assert.equal(deriveTeamHandoff(session(runs))?.fromAgentId, "ada");
  });
});
