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

function workGraph() {
  return {
    contract: { name: "relay.collaboration.work-graph", version: 1 },
    items: [
      { workItemId: "w-build", assignmentId: "a1", ownerAgentId: "ada", delegationAuthority: "conductor", kind: "implementation", objective: "Build", dependsOnWorkItemIds: [], required: true },
      { workItemId: "w-review", assignmentId: "a2", ownerAgentId: "rex", delegationAuthority: "conductor", kind: "review", objective: "Review", dependsOnWorkItemIds: ["w-build"], required: true },
    ],
    completion: { kind: "all_required" },
    delegationPolicy: { authority: "conductor", policy: "sequential-role-delegation-v1" },
  } as NonNullable<NonNullable<RelaySession["collaborationRounds"]>[number]["workGraph"]>;
}

describe("deriveTeamHandoff", () => {
  it("names the next teammate in the gap after a member finishes", () => {
    const handoff = deriveTeamHandoff(session([run("r1", "a1", "ada")]));
    assert.deepEqual(handoff, {
      fromRunId: "r1",
      fromAgentId: "ada",
      fromAgent: "claude",
      toAgentId: "rex",
      outcome: "completed",
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

  it("reports a failed member the round recovers from, without guessing the target", () => {
    const handoff = deriveTeamHandoff(session([run("r1", "a1", "ada", { status: "failed" })]));
    assert.equal(handoff?.outcome, "failed");
    assert.equal(handoff?.toAgentId, null);
  });

  it("stays quiet for a single-member round", () => {
    const s = session([run("r1", "a1", "ada")]);
    const round = s.collaborationRounds![0]!;
    s.collaborationRounds = [{ ...round, assignments: round.assignments.slice(0, 1) }];
    assert.equal(deriveTeamHandoff(s), null);
  });

  it("routes a reviewer's change request back to the builder on a round without a work graph", () => {
    const runs = [
      run("r1", "a1", "ada"),
      run("r2", "a2", "rex", { workResult: { status: "continue", evidence: [], findings: [{ workItemId: "a1", note: "fix" }] } }),
    ];
    assert.equal(deriveTeamHandoff(session(runs, "build_review"))?.toAgentId, "ada");
  });

  it("leaves the target open when the last assignment has finished", () => {
    const runs = [run("r1", "a1", "ada"), run("r2", "a2", "rex", { workResult: { status: "done", evidence: [] } })];
    assert.equal(deriveTeamHandoff(session(runs, "build_review"))?.toAgentId, null);
  });

  it("routes repair findings to the work item's owner", () => {
    const s = session([
      run("r1", "a1", "ada"),
      run("r2", "a2", "rex", { workResult: { status: "continue", evidence: [], findings: [{ workItemId: "w-build", note: "fix" }] } }),
    ], "pipeline");
    s.collaborationRounds = [{ ...s.collaborationRounds![0]!, workGraph: workGraph() }];
    assert.equal(deriveTeamHandoff(s)?.toAgentId, "ada");
  });

  it("routes a question to the teammate it names", () => {
    const s = session([
      run("r1", "a1", "ada"),
      run("r2", "a2", "rex", { workResult: { status: "blocked", evidence: [], messages: [{ kind: "question", toWorkItemId: "w-build", text: "Why?" }] } }),
    ]);
    s.collaborationRounds = [{ ...s.collaborationRounds![0]!, workGraph: workGraph() }];
    assert.equal(deriveTeamHandoff(s)?.toAgentId, "ada");
  });

  it("routes an answer back to the teammate who asked", () => {
    const s = session([
      run("r1", "a1", "ada", { workResult: { status: "done", evidence: [], messages: [{ kind: "answer", toWorkItemId: "w-review", text: "Because" }] } }),
    ]);
    s.collaborationRounds = [{ ...s.collaborationRounds![0]!, workGraph: workGraph() }];
    assert.equal(deriveTeamHandoff(s)?.toAgentId, "rex");
  });

  it("leaves the target open when a result is not done and names no one", () => {
    const runs = [run("r1", "a1", "ada", { workResult: { status: "blocked", evidence: [] } })];
    assert.equal(deriveTeamHandoff(session(runs))?.toAgentId, null);
  });

  it("ignores consultations when picking who spoke last", () => {
    const runs = [run("r1", "a1", "ada"), run("r2", "a2", "rex", { consultation: true })];
    assert.equal(deriveTeamHandoff(session(runs))?.fromAgentId, "ada");
  });
});
