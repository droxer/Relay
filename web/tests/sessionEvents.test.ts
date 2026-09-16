import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { applySessionEvent } from "../src/lib/sessionEvents.js";
import type { RelaySession } from "../src/types.js";

function session(partial: Partial<RelaySession> = {}): RelaySession {
  return {
    id: "ses_1",
    workspacePath: "/workspace",
    taskGoal: "fix auth",
    participants: ["human", "codex"],
    status: "running",
    phase: "created",
    createdAt: "2026-06-20T00:00:00.000Z",
    updatedAt: "2026-06-20T00:00:00.000Z",
    agentRuns: [],
    artifacts: [],
    decisions: [],
    events: [],
    ...partial,
  } as RelaySession;
}

describe("applySessionEvent", () => {
  it("materializes collaboration round identity and strategy from SSE", () => {
    const updated = applySessionEvent(session(), {
      id: "evt_round",
      type: "collaboration.round.started",
      sessionId: "ses_1",
      timestamp: "2026-06-20T00:00:00.500Z",
      manifest: {
        contract: { name: "relay.collaboration.round", version: 2 },
        collaborationId: "col_1",
        roundId: "round_1",
        source: "message",
        purpose: "review",
        strategy: "review",
        address: { kind: "room" },
        assignments: [{
          assignmentId: "assignment_1",
          agentId: "agent_1",
          mode: "review",
          phase: "review",
        }],
        completionPolicy: "synthesize",
        workGraph: {
          contract: { name: "relay.collaboration.work-graph", version: 1 },
          items: [{
            workItemId: "assignment_1",
            assignmentId: "assignment_1",
            ownerAgentId: "agent_1",
            delegationAuthority: "conductor",
            kind: "review",
            objective: "Review the result.",
            dependsOnWorkItemIds: [],
            required: true,
          }],
          completion: { kind: "synthesize", resultOwnerWorkItemId: "assignment_1" },
          delegationPolicy: { authority: "conductor", policy: "sequential-role-delegation-v1" },
        },
      },
    });

    assert.equal(updated.activeCollaborationId, "col_1");
    assert.equal(updated.activeRoundId, "round_1");
    assert.equal(updated.collaborationRevision, 1);
    assert.equal(updated.collaborationRounds[0]?.strategy, "review");
    assert.equal(updated.collaborationRounds[0]?.workGraph?.items[0]?.kind, "review");
  });

  it("preserves runtime affinity from streamed run starts", () => {
    const workspaceIdentity = { kind: "host", workspacePath: "/workspace" };
    const updated = applySessionEvent(session(), {
      id: "evt_started",
      type: "agent.started",
      sessionId: "ses_1",
      timestamp: "2026-06-20T00:00:01.000Z",
      runId: "run_1",
      assignmentId: "assignment_1",
      workItemId: "assignment_1",
      delegationAuthority: "conductor",
      dependsOnWorkItemIds: ["work_plan"],
      workKind: "implementation",
      agent: "codex",
      logicalAgentId: "agent_1",
      placementId: "placement_1",
      daemonNodeId: "node_1",
      agentVersion: 3,
      workspaceIdentity,
      role: "implementer",
      brief: "Implement only the migration.",
      coordinator: true,
      synthesizer: true,
      teamSnapshot: {
        teamId: "team_1",
        teamRevision: "2026-06-20T00:00:00.000Z",
        memberAgentIds: ["agent_1", "agent_2"],
        leadAgentId: "agent_1",
      },
      teamPhase: "execution",
    });

    assert.equal(updated.agentRuns[0]?.assignmentId, "assignment_1");
    assert.equal(updated.agentRuns[0]?.workItemId, "assignment_1");
    assert.equal(updated.agentRuns[0]?.delegationAuthority, "conductor");
    assert.deepEqual(updated.agentRuns[0]?.dependsOnWorkItemIds, ["work_plan"]);
    assert.equal(updated.agentRuns[0]?.workKind, "implementation");
    assert.equal(updated.agentRuns[0]?.daemonNodeId, "node_1");
    assert.equal(updated.agentRuns[0]?.placementId, "placement_1");
    assert.equal(updated.agentRuns[0]?.agentVersion, 3);
    assert.deepEqual(updated.agentRuns[0]?.workspaceIdentity, workspaceIdentity);
    assert.equal(updated.agentRuns[0]?.brief, "Implement only the migration.");
    assert.equal(updated.agentRuns[0]?.coordinator, true);
    assert.equal(updated.agentRuns[0]?.synthesizer, true);
    assert.equal(updated.agentRuns[0]?.teamPhase, "execution");
    assert.deepEqual(updated.agentRuns[0]?.teamSnapshot?.memberAgentIds, [
      "agent_1",
      "agent_2",
    ]);
  });

  it("materializes streamed feedback waits before the list poll catches up", () => {
    const updated = applySessionEvent(session(), {
      id: "evt_wait",
      type: "session.status",
      sessionId: "ses_1",
      timestamp: "2026-06-20T00:00:05.000Z",
      status: "waiting_for_human",
      phase: "needs_feedback",
      pendingDecision: "feedback",
    });

    assert.equal(updated.status, "waiting_for_human");
    assert.equal(updated.phase, "needs_feedback");
    assert.equal(updated.pendingDecision, "feedback");
    assert.equal(updated.updatedAt, "2026-06-20T00:00:05.000Z");
    assert.deepEqual(updated.events.map((event) => event.id), ["evt_wait"]);
  });

  it("clears stale feedback and final outcome fields on non-terminal status updates", () => {
    const updated = applySessionEvent(session({
      status: "failed",
      phase: "failed",
      pendingDecision: "feedback",
      finalOutcome: "old failure",
    }), {
      id: "evt_running",
      type: "session.status",
      sessionId: "ses_1",
      timestamp: "2026-06-20T00:00:06.000Z",
      status: "running",
      phase: "approved",
    });

    assert.equal(updated.status, "running");
    assert.equal(updated.phase, "approved");
    assert.equal("pendingDecision" in updated, false);
    assert.equal("finalOutcome" in updated, false);
  });

  it("materializes streamed run completion and token usage before the list poll catches up", () => {
    const base = session({
      currentAgent: "codex",
      phase: "codex:action",
      agentRuns: [{
        id: "run_1",
        agent: "codex",
        role: "implementer",
        status: "running",
        startedAt: "2026-06-20T00:00:00.000Z",
        artifactIds: [],
      }],
    });

    const updated = applySessionEvent(base, {
      id: "evt_done",
      type: "agent.completed",
      sessionId: "ses_1",
      timestamp: "2026-06-20T00:01:00.000Z",
      runId: "run_1",
      agent: "codex",
      status: "completed",
      exitCode: 0,
      tokenUsage: { input: 10, output: 4, cache: 1, total: 15 },
    });

    assert.equal(updated.currentAgent, undefined);
    assert.equal(updated.phase, "agent_completed");
    assert.deepEqual(updated.agentRuns[0], {
      id: "run_1",
      agent: "codex",
      role: "implementer",
      status: "completed",
      startedAt: "2026-06-20T00:00:00.000Z",
      completedAt: "2026-06-20T00:01:00.000Z",
      exitCode: 0,
      tokenUsage: { input: 10, output: 4, cache: 1, total: 15 },
      artifactIds: [],
    });
    assert.deepEqual(updated.tokenUsage, { input: 10, output: 4, cache: 1, total: 15 });
  });

  it("clears stale feedback waits on terminal streamed events", () => {
    const base = session({
      status: "waiting_for_human",
      phase: "feedback",
      pendingDecision: "feedback",
      currentAgent: "codex",
    });

    const completed = applySessionEvent(base, {
      id: "evt_completed",
      type: "session.completed",
      sessionId: "ses_1",
      timestamp: "2026-06-20T00:02:00.000Z",
      outcome: "done",
    });
    assert.equal(completed.status, "completed");
    assert.equal("pendingDecision" in completed, false);
    assert.equal("currentAgent" in completed, false);

    const failed = applySessionEvent(base, {
      id: "evt_failed",
      type: "session.failed",
      sessionId: "ses_1",
      timestamp: "2026-06-20T00:03:00.000Z",
      outcome: "failed",
    });
    assert.equal(failed.status, "failed");
    assert.equal("pendingDecision" in failed, false);
    assert.equal("currentAgent" in failed, false);
  });

  it("clears stale feedback waits on streamed cancel decisions", () => {
    const updated = applySessionEvent(session({
      status: "waiting_for_human",
      phase: "feedback",
      pendingDecision: "feedback",
    }), {
      id: "evt_cancel",
      type: "human.decision",
      sessionId: "ses_1",
      timestamp: "2026-06-20T00:04:00.000Z",
      decision: {
        id: "dec_cancel",
        kind: "cancel",
        createdAt: "2026-06-20T00:04:00.000Z",
      },
    });

    assert.equal(updated.status, "cancelled");
    assert.equal(updated.phase, "cancelled");
    assert.equal("pendingDecision" in updated, false);
  });
});

it("new execution events invalidate a previous terminal lifecycle snapshot", () => {
  const original = session({ execution: { phase: "terminal", canDelete: true, executionConfirmed: false,
    deletionRequested: false, blockingReason: null, lastConfirmedAt: null, nextRecoveryAt: null } });
  const next = applySessionEvent(original, { id: "event-new-run", type: "session.status", sessionId: original.id,
    timestamp: "2026-09-16T00:00:00Z", status: "running", phase: "action" });
  assert.equal(next.execution, undefined);
  assert.equal(original.execution?.phase, "terminal");
});
