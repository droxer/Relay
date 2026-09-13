import assert from "node:assert/strict";
import { test } from "node:test";
import { deriveHandoffStatus } from "../src/lib/handoffStatus.js";
import { applySessionEvent } from "../src/lib/sessionEvents.js";
import type { RelaySession } from "../src/types.js";

const context = { targetAgentId: "reviewer", targetDisplayName: "Reviewer", assignmentId: "a", note: "verify", contract: {name: "relay.handoff.context", version: 1} };
function session(): RelaySession {
  return { id: "s", taskGoal: "goal", workspacePath: "/workspace", status: "running", phase: "handoff:codex", events: [], agentRuns: [], artifacts: [], decisions: [], participants: [], createdAt: "now", updatedAt: "now", activeRoundId: "r", collaborationRounds: [{roundId: "r", handoffContext: context}] } as unknown as RelaySession;
}
test("handoff requires delivery evidence, not a staged agent.started run", () => {
  const s = session();
  s.agentRuns = [{id: "run", assignmentId: "a", agent: "codex", status: "running"}] as RelaySession["agentRuns"];
  assert.equal(deriveHandoffStatus(s)?.status, "accepted");
  const queued = applySessionEvent(s, {id: "q", sessionId: "s", timestamp: "now", type: "collaboration.delivery", roundId: "r", assignmentId: "a", runId: "run", status: "queued"});
  assert.equal(deriveHandoffStatus(queued)?.status, "queued");
  const running = applySessionEvent(queued, {id: "x", sessionId: "s", timestamp: "now", type: "collaboration.delivery", roundId: "r", assignmentId: "a", runId: "run", status: "running"});
  assert.equal(deriveHandoffStatus(running)?.status, "running");
  assert.equal(deriveHandoffStatus(applySessionEvent(running, queued.events[0]))?.status, "running");
  running.agentRuns[0].status = "failed";
  assert.equal(deriveHandoffStatus(running)?.status, "failed");
});
test("legacy rounds remain readable and a newer round hides old handoffs", () => {
  const s = session();
  s.activeRoundId = "new";
  assert.equal(deriveHandoffStatus(s), null);
  delete s.activeRoundId;
  s.collaborationRounds = [];
  assert.equal(deriveHandoffStatus(s), null);
});

test("round context and delivery evidence survive core replay and browser SSE", async () => {
  const { materializeEvents, relayEvent } = await import("../../packages/relay-core/src/session-store.js");
  const round = session().collaborationRounds[0];
  const created = relayEvent("session.created", "s", { workspacePath: "/workspace", taskGoal: "goal", participants: ["human", "codex"] });
  const accepted = relayEvent("collaboration.round.started", "s", {manifest: round});
  const delivery = relayEvent("collaboration.delivery", "s", {roundId: "r", assignmentId: "a", runId: "run", status: "queued"});
  const events = [created, accepted, delivery];
  const replay = materializeEvents(events);
  const streamed = applySessionEvent(applySessionEvent(materializeEvents([created]), accepted), delivery);
  assert.deepEqual(replay.collaborationRounds, streamed.collaborationRounds);
  assert.deepEqual(replay.collaborationRounds[0].handoffContext, context);
  assert.equal(deriveHandoffStatus(replay)?.status, "queued");
  assert.deepEqual(deriveHandoffStatus(replay), deriveHandoffStatus(streamed));
});

test("cancelled admission and old-daemon output have distinct lifecycle evidence", () => {
  const s = session();
  s.status = "cancelled";
  assert.equal(deriveHandoffStatus(s)?.status, "cancelled");
  s.status = "running";
  s.agentRuns = [{id: "run", assignmentId: "a", agent: "codex", status: "running"}] as RelaySession["agentRuns"];
  const active = applySessionEvent(s, {id: "o", type: "agent.output", sessionId: "s", timestamp: "now", agent: "codex", runId: "run", stream: "stdout", text: "working"});
  assert.equal(deriveHandoffStatus(active)?.status, "running");
});
