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
      phase: "handoff",
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

  it("does not guess a repair owner on a round without a work graph", () => {
    // Without work kinds the web cannot tell whether the conductor repairs or ends the round.
    const runs = [
      run("r1", "a1", "ada"),
      run("r2", "a2", "rex", { workResult: { status: "continue", evidence: [], findings: [{ workItemId: "a1", note: "fix" }] } }),
    ];
    const handoff = deriveTeamHandoff(session(runs, "build_review"));
    assert.equal(handoff?.toAgentId, null);
    assert.equal(handoff?.phase, "closing");
  });

  it("names the repair owner in Pipeline and Lead-led rounds", () => {
    for (const style of ["pipeline", "lead_led"] as const) {
      const s = session([
        run("r1", "a1", "lead"),
        run("r2", "a2", "ada"),
        run("r3", "a3", "rex", {
          role: "reviewer",
          workResult: { status: "continue", evidence: [], findings: [{ workItemId: "build", note: "fix" }] },
        }),
      ], style);
      const round = s.collaborationRounds![0]!;
      round.assignments = [
        { assignmentId: "a1", agentId: "lead", role: "planner" },
        { assignmentId: "a2", agentId: "ada", role: "implementer" },
        { assignmentId: "a3", agentId: "rex", role: "reviewer" },
        ...(style === "lead_led" ? [{ assignmentId: "a4", agentId: "lead", synthesizer: true }] : []),
      ];
      round.workGraph = {
        contract: { name: "relay.collaboration.work-graph", version: 1 },
        items: [
          { workItemId: "plan", assignmentId: "a1", ownerAgentId: "lead", delegationAuthority: "conductor", kind: "planning", objective: "Plan", dependsOnWorkItemIds: [], required: true },
          { workItemId: "build", assignmentId: "a2", ownerAgentId: "ada", delegationAuthority: "conductor", kind: "implementation", objective: "Build", dependsOnWorkItemIds: ["plan"], required: true },
          { workItemId: "review", assignmentId: "a3", ownerAgentId: "rex", delegationAuthority: "conductor", kind: "review", objective: "Review", dependsOnWorkItemIds: ["build"], required: true },
        ],
        completion: { kind: "all_required" },
        delegationPolicy: { authority: "conductor", policy: "sequential-role-delegation-v1" },
      };
      assert.equal(deriveTeamHandoff(s)?.toAgentId, "ada", style);
    }
  });

  it("reads as closing once the round's final member has finished", () => {
    const runs = [run("r1", "a1", "ada"), run("r2", "a2", "rex", { workResult: { status: "done", evidence: [] } })];
    const handoff = deriveTeamHandoff(session(runs, "build_review"));
    assert.equal(handoff?.toAgentId, null);
    assert.equal(handoff?.phase, "closing");
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

  it("resumes the asker once a consultation is answered", () => {
    const s = session([
      run("r1", "a1", "ada", { workResult: { status: "done", evidence: ["built"] } }),
      run("r2", "a2", "rex", { workResult: { status: "blocked", evidence: [], messages: [{ kind: "question", toWorkItemId: "w-build", text: "Why?" }] } }),
      run("r3", "a1", "ada", { consultation: true, workResult: { status: "done", evidence: [], messages: [{ kind: "answer", toWorkItemId: "w-review", text: "Because" }] } }),
    ]);
    s.collaborationRounds = [{ ...s.collaborationRounds![0]!, workGraph: workGraph() }];
    const handoff = deriveTeamHandoff(s);
    assert.equal(handoff?.fromRunId, "r3");
    assert.equal(handoff?.fromAgentId, "ada");
    assert.equal(handoff?.toAgentId, "rex");
  });

  it("resumes the asker when the consultation answer has no explicit recipient", () => {
    const s = session([
      run("r1", "a1", "ada", { workResult: { status: "done", evidence: ["built"] } }),
      run("r2", "a2", "rex", { workResult: { status: "blocked", evidence: [], messages: [{ kind: "question", toWorkItemId: "w-build", text: "Why?" }] } }),
      run("r3", "a1", "ada", { consultation: true, workResult: { status: "done", evidence: [], messages: [{ kind: "answer", text: "Because" }] } }),
    ]);
    s.collaborationRounds = [{ ...s.collaborationRounds![0]!, workGraph: workGraph() }];
    assert.equal(deriveTeamHandoff(s)?.phase, "handoff");
    assert.equal(deriveTeamHandoff(s)?.toAgentId, "rex");
  });

  it("reads as closing when a consultation ends without answering its asker", () => {
    const s = session([
      run("r1", "a1", "ada", { workResult: { status: "done", evidence: ["built"] } }),
      run("r2", "a2", "rex", { workResult: { status: "blocked", evidence: [], messages: [{ kind: "question", toWorkItemId: "w-build", text: "Why?" }] } }),
      run("r3", "a1", "ada", { consultation: true, workResult: { status: "done", evidence: [] } }),
    ]);
    s.collaborationRounds = [{ ...s.collaborationRounds![0]!, workGraph: workGraph() }];
    assert.equal(deriveTeamHandoff(s)?.phase, "closing");
  });

  it("advances in order after a done turn that is not an answer turn", () => {
    const s = session([
      run("r1", "a1", "ada", { workResult: { status: "done", evidence: ["built"], messages: [{ kind: "answer", toWorkItemId: "w-review", text: "FYI" }] } }),
    ]);
    s.collaborationRounds = [{ ...s.collaborationRounds![0]!, workGraph: workGraph() }];
    assert.equal(deriveTeamHandoff(s)?.toAgentId, "rex");
  });

  it("ignores a question addressed to a later assignment", () => {
    const s = session([
      run("r1", "a1", "ada", { workResult: { status: "blocked", evidence: [], messages: [{ kind: "question", toWorkItemId: "w-review", text: "Ready?" }] } }),
    ]);
    s.collaborationRounds = [{ ...s.collaborationRounds![0]!, workGraph: workGraph() }];
    const handoff = deriveTeamHandoff(s);
    assert.equal(handoff?.toAgentId, null);
    assert.equal(handoff?.phase, "closing");
  });

  it("stops consulting once the round's consultation budget is spent", () => {
    const ask = { status: "blocked" as const, evidence: [], messages: [{ kind: "question" as const, toWorkItemId: "w-build", text: "Why?" }] };
    const answer = { status: "done" as const, evidence: [], messages: [{ kind: "answer" as const, toWorkItemId: "w-review", text: "Because" }] };
    const s = session([
      run("r1", "a1", "ada", { workResult: { status: "done", evidence: ["built"] } }),
      run("r2", "a2", "rex", { workResult: ask }),
      run("r3", "a1", "ada", { consultation: true, workResult: answer }),
      run("r4", "a2", "rex", { workResult: ask }),
      run("r5", "a1", "ada", { consultation: true, workResult: answer }),
      run("r6", "a2", "rex", { workResult: ask }),
    ]);
    s.collaborationRounds = [{ ...s.collaborationRounds![0]!, workGraph: workGraph() }];
    assert.equal(deriveTeamHandoff(s)?.phase, "closing");
  });

  it("reads as closing when a required member reports work that is not done", () => {
    const runs = [run("r1", "a1", "ada", { workResult: { status: "blocked", evidence: [] } })];
    const handoff = deriveTeamHandoff(session(runs));
    assert.equal(handoff?.toAgentId, null);
    assert.equal(handoff?.phase, "closing");
  });

  it("advances past an optional member whose work is not done", () => {
    const s = session([run("r1", "a1", "ada", { workResult: { status: "continue", evidence: [] } })]);
    const graph = workGraph();
    s.collaborationRounds = [{ ...s.collaborationRounds![0]!, workGraph: { ...graph, items: graph.items.map((item) => (item.assignmentId === "a1" ? { ...item, required: false } : item)) } }];
    assert.equal(deriveTeamHandoff(s)?.toAgentId, "rex");
  });

  it("reads as closing when a required member gives no report and the style does not inspect", () => {
    const s = session([
      run("r1", "a1", "ada", { workResult: { status: "done", evidence: ["planned"] } }),
      run("r2", "a2", "rex"),
      run("r3", "a3", "kai"),
    ]);
    const round = s.collaborationRounds![0]!;
    s.collaborationRounds = [{ ...round, assignments: [...round.assignments, { assignmentId: "a3", agentId: "kai" }] }];
    // Inspecting styles let the next member look at the workspace instead.
    s.agentRuns = s.agentRuns.map((item) => ({ ...item, teamSnapshot: { teamId: "t", memberAgentIds: [], collaborationStyle: "solo" } }));
    s.agentRuns = s.agentRuns.slice(0, 2);
    assert.equal(deriveTeamHandoff(s)?.phase, "closing");
    s.agentRuns = s.agentRuns.map((item) => ({ ...item, teamSnapshot: { teamId: "t", memberAgentIds: [], collaborationStyle: "pipeline" } }));
    assert.equal(deriveTeamHandoff(s)?.toAgentId, "kai");
  });

  it("leaves the target open when no report says whether the round is gated", () => {
    const s = session([run("r1", "a1", "ada", { coordinator: true })]);
    const round = s.collaborationRounds![0]!;
    s.collaborationRounds = [{ ...round, assignments: [{ ...round.assignments[0]!, coordinator: true }, round.assignments[1]!] }];
    const handoff = deriveTeamHandoff(s);
    assert.equal(handoff?.phase, "open");
    assert.equal(handoff?.toAgentId, null);
  });

  it("routes repair findings to the earliest cited implementation item", () => {
    const s = session([
      run("r1", "a1", "ada", { workResult: { status: "done", evidence: ["built"] } }),
      run("r2", "a2", "bo", { workResult: { status: "done", evidence: ["fixed"] } }),
      run("r3", "a3", "rex", { workResult: { status: "continue", evidence: [], findings: [{ workItemId: "w-fix", note: "again" }, { workItemId: "w-build", note: "broken" }] } }),
    ]);
    s.collaborationRounds = [{
      ...s.collaborationRounds![0]!,
      assignments: [
        { assignmentId: "a1", agentId: "ada" },
        { assignmentId: "a2", agentId: "bo" },
        { assignmentId: "a3", agentId: "rex" },
      ],
      workGraph: {
        ...workGraph(),
        items: [
          { workItemId: "w-build", assignmentId: "a1", ownerAgentId: "ada", delegationAuthority: "conductor", kind: "implementation", objective: "Build", dependsOnWorkItemIds: [], required: true },
          { workItemId: "w-fix", assignmentId: "a2", ownerAgentId: "bo", delegationAuthority: "conductor", kind: "repair", objective: "Fix", dependsOnWorkItemIds: [], required: true },
          { workItemId: "w-review", assignmentId: "a3", ownerAgentId: "rex", delegationAuthority: "conductor", kind: "review", objective: "Review", dependsOnWorkItemIds: [], required: true },
        ],
      },
    }];
    assert.equal(deriveTeamHandoff(s)?.toAgentId, "ada");
  });

  it("does not route findings that cite a non-implementation item", () => {
    const s = session([
      run("r1", "a1", "ada", { workResult: { status: "done", evidence: ["built"] } }),
      run("r2", "a2", "rex", { workResult: { status: "continue", evidence: [], findings: [{ workItemId: "w-build", note: "fix" }] } }),
    ]);
    const graph = workGraph();
    s.collaborationRounds = [{ ...s.collaborationRounds![0]!, workGraph: { ...graph, items: graph.items.map((item) => (item.assignmentId === "a1" ? { ...item, kind: "verification" as const } : item)) } }];
    assert.equal(deriveTeamHandoff(s)?.phase, "closing");
  });

  it("stops repairing once the round's repair budget is spent", () => {
    const finding = { status: "continue" as const, evidence: [], findings: [{ workItemId: "w-build", note: "fix" }] };
    const built = { status: "done" as const, evidence: ["built"] };
    const s = session([
      run("r1", "a1", "ada", { workResult: built }),
      run("r2", "a2", "rex", { workResult: finding }),
      run("r3", "a1", "ada", { workResult: built }),
      run("r4", "a2", "rex", { workResult: finding }),
      run("r5", "a1", "ada", { workResult: built }),
      run("r6", "a2", "rex", { workResult: finding }),
    ]);
    s.collaborationRounds = [{ ...s.collaborationRounds![0]!, workGraph: workGraph() }];
    assert.equal(deriveTeamHandoff(s)?.phase, "closing");
    s.agentRuns = s.agentRuns.slice(0, 4);
    assert.equal(deriveTeamHandoff(s)?.toAgentId, "ada");
  });

  it("follows a lead plan into its own round, where the coordinator keeps its assignment", () => {
    const plan = { status: "done" as const, evidence: ["planned"], plan: [{ agentId: "ada", objective: "Build", acceptanceCriteria: ["works"], expectedOutputs: ["code"] }] };
    const s = session([run("r1", "lead-a", "lead", { coordinator: true, workResult: plan })]);
    s.activeRoundId = "r_plan";
    s.collaborationRounds = [
      { ...s.collaborationRounds![0]!, assignments: [{ assignmentId: "lead-a", agentId: "lead", coordinator: true }, { assignmentId: "a1", agentId: "ada" }] },
      {
        ...s.collaborationRounds![0]!,
        roundId: "r_plan",
        source: "lead_plan",
        parentRoundId: "r",
        assignments: [{ assignmentId: "lead-a", agentId: "lead", coordinator: true }, { assignmentId: "p1", agentId: "ada" }],
      },
    ];
    assert.equal(deriveTeamHandoff(s)?.toAgentId, "ada");
    // Before the plan round is recorded, the plan itself names the next owner.
    s.activeRoundId = "r";
    assert.equal(deriveTeamHandoff(s)?.toAgentId, "ada");
    // A coordinator's first turn without a plan ends the round on a plan error.
    s.agentRuns = [run("r1", "lead-a", "lead", { coordinator: true, workResult: { status: "done", evidence: ["ok"] } })];
    assert.equal(deriveTeamHandoff(s)?.phase, "closing");
    // An empty plan still compiles to the closing synthesis turn unless it
    // drops required work; only the conductor can tell, so it stays open.
    s.agentRuns = [run("r1", "lead-a", "lead", { coordinator: true, workResult: { status: "done", evidence: ["ok"], plan: [] } as never })];
    assert.equal(deriveTeamHandoff(s)?.phase, "open");
  });

  it("stays quiet after a cancelled turn", () => {
    assert.equal(deriveTeamHandoff(session([run("r1", "a1", "ada", { status: "cancelled" })])), null);
  });
});
