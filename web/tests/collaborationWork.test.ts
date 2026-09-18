import assert from "node:assert/strict";
import test from "node:test";
import { deriveCollaborationWork } from "../src/lib/collaborationWork.js";
import type { RelaySession } from "../src/types.js";

test("successful execution without evidence is unverified; repair invalidates old review", () => {
  const session = {
    collaborationRounds: [{ roundId: "r", workGraph: { items: [
      { workItemId: "build", assignmentId: "build", ownerAgentId: "a", objective: "API", dependsOnWorkItemIds: [], required: true },
      { workItemId: "review", assignmentId: "review", ownerAgentId: "b", objective: "Review", dependsOnWorkItemIds: ["build"], required: true },
    ] } }],
    agentRuns: [
      { id: "1", assignmentId: "build", status: "completed" },
      { id: "2", assignmentId: "review", status: "completed", workResult: { status: "done", evidence: ["Checks passed"] } },
      { id: "3", assignmentId: "build", status: "running" },
    ],
  } as unknown as RelaySession;
  assert.deepEqual(deriveCollaborationWork(session).map(item => item.status), ["running", "stale"]);
  session.agentRuns.pop();
  assert.equal(deriveCollaborationWork(session)[0].status, "unverified");
  session.agentRuns.push({ id: "answer", assignmentId: "build", consultation: true, status: "completed",
    workResult: { status: "done", evidence: ["Answered the reviewer's question"], messages: [{ kind: "answer", toWorkItemId: "review", text: "Empty input returns 400" }] } } as unknown as RelaySession["agentRuns"][number]);
  assert.equal(deriveCollaborationWork(session)[1].status, "accepted");
  assert.equal(deriveCollaborationWork(session)[0].messages[0].text, "Empty input returns 400");
});
