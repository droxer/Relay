import assert from "node:assert/strict";
import { test } from "node:test";
import type { RelaySession } from "../src/types.js";
import { directDelegations } from "../src/lib/directDelegations.js";

function session(): RelaySession {
  return { status: "running", events: [], agentRuns: [], collaborationRounds: [
    { source: "direct_delegation", delegation: { id: "d", requestedByAgentId: "a", targetAgentId: "b",
      requesterAssignmentId: "request", childAssignmentId: "child", resumeAssignmentId: "resume",
      objective: "Write tests", acceptanceCriteria: ["Expiry covered"], expectedOutputs: ["tests"] } },
  ] } as unknown as RelaySession;
}

test("staging alone never claims a delegate is executing", () => {
  const s = session();
  s.agentRuns = [{ id: "b-run", assignmentId: "child", status: "running" }] as RelaySession["agentRuns"];
  assert.equal(directDelegations(s)[0].status, "queued");
  s.events = [{ type: "collaboration.delivery", assignmentId: "child", status: "running" }] as RelaySession["events"];
  assert.equal(directDelegations(s)[0].status, "working");
});

test("child completion returns work; only A's report can claim completion", () => {
  const s = session();
  s.agentRuns = [{ id: "b", assignmentId: "child", status: "completed", workResult: {status: "done", evidence: ["pytest passed"]} }] as RelaySession["agentRuns"];
  assert.equal(directDelegations(s)[0].status, "returned");
  s.agentRuns.push({ id: "a", assignmentId: "resume", status: "completed", exitCode: 0 } as RelaySession["agentRuns"][number]);
  assert.equal(directDelegations(s)[0].status, "needs_attention");
  s.agentRuns[1].workResult = {status: "done", evidence: ["Inspected and tested"]};
  assert.equal(directDelegations(s)[0].status, "reported_done");
});

test("an accepted second delegation shows that the first requester resumed", () => {
  const s = session();
  const first = s.collaborationRounds?.[0];
  assert.ok(first?.delegation);
  s.collaborationRounds = [first, {
    ...first,
    delegation: { ...first.delegation, id: "second", requesterAssignmentId: "resume",
      childAssignmentId: "second-child", resumeAssignmentId: "second-resume" },
  }];
  s.agentRuns = [
    { id: "a2", assignmentId: "resume", status: "completed", agent: "codex", startedAt: "2026-01-01T00:00:00Z", artifactIds: [] },
  ];
  assert.deepEqual(directDelegations(s).map(({ status }) => status), ["resuming", "queued"]);

  s.agentRuns.push({ id: "a3", assignmentId: "second-resume", status: "completed", agent: "codex",
    startedAt: "2026-01-01T00:01:00Z", artifactIds: [],
    workResult: { status: "blocked", evidence: [], note: "Still needs review" } });
  assert.deepEqual(directDelegations(s).map(({ status }) => status), ["resuming", "needs_attention"]);
  s.agentRuns[1].workResult = { status: "done", evidence: ["Inspected and tested both reports"] };
  s.status = "completed";
  assert.deepEqual(directDelegations(s).map(({ status }) => status), ["resuming", "reported_done"]);
});

test("cancelled threads retain delegation history and show cancellation", () => {
  const s = session();
  s.status = "cancelled";
  assert.equal(directDelegations(s)[0].status, "cancelled");
  assert.deepEqual(directDelegations({...s, collaborationRounds: []}), []);
});
