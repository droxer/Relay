import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { applySessionEvent } from "../src/lib/sessionEvents.js";
import { threadAwaitsHuman } from "../src/lib/awaitingInput.js";
import { permissionInputText, permissionNoteReachesAgent } from "../src/lib/permissionRequests.js";
import { materializeEvents, relayEvent } from "../../packages/relay-core/src/index.js";

const created = relayEvent("session.created", "ses_1", { workspacePath: "/workspace", taskGoal: "Clean up", participants: ["human", "claude"] });
const started = relayEvent("agent.started", "ses_1", { runId: "run_1", agent: "claude" });
const asked = relayEvent("agent.permission_requested", "ses_1", {
  request: { id: "perm_00000001", runId: "run_1", agent: "claude", toolName: "Bash", input: "{\"command\":\"make clean\"}" },
});

/** Replay (relay-core) and the live stream (web) must agree on every step. */
function both(events: ReturnType<typeof relayEvent>[]) {
  const replay = materializeEvents([created, ...events]);
  const live = events.reduce(applySessionEvent, materializeEvents([created]));
  return { replay, live };
}

describe("runtime permission prompts", () => {
  it("opens a prompt once, and a person's answer closes it", () => {
    const opened = both([started, asked, { ...asked, id: "evt_retry" }]);
    for (const session of [opened.replay, opened.live]) {
      assert.deepEqual(session.permissionRequests?.map((item) => item.id), ["perm_00000001"]);
      assert.equal(threadAwaitsHuman(session, []), true);
    }
    const answered = relayEvent("agent.permission_resolved", "ses_1", { requestId: "perm_00000001", decision: "deny", note: "Not that", actorUserId: "user_1" });
    const closed = both([started, asked, answered]);
    for (const session of [closed.replay, closed.live]) {
      assert.equal(session.permissionRequests, undefined);
      assert.deepEqual(session.permissionDecisions?.map(({ requestId, decision, note, decidedBy }) => ({ requestId, decision, note, decidedBy })), [
        { requestId: "perm_00000001", decision: "deny", note: "Not that", decidedBy: "user_1" },
      ]);
      assert.equal(threadAwaitsHuman(session, []), false);
    }
  });

  it("expires a prompt whose run ends first, and ignores a late answer", () => {
    const ended = relayEvent("agent.completed", "ses_1", { runId: "run_1", agent: "claude", status: "cancelled", exitCode: 130 });
    const late = relayEvent("agent.permission_resolved", "ses_1", { requestId: "perm_00000001", decision: "allow" });
    const { replay, live } = both([started, asked, ended, late]);
    for (const session of [replay, live]) {
      assert.equal(session.permissionRequests, undefined);
      assert.deepEqual(session.permissionDecisions?.map((item) => item.decision), ["expired"]);
    }
  });

  it("offers a deny note only where the runtime carries it to the agent", () => {
    assert.deepEqual(
      (["claude", "pi", "codex", "kimi"] as const).map((agent) => permissionNoteReachesAgent({ agent })),
      [true, true, false, false],
    );
  });

  it("shows the tool input as readable JSON, and anything else as sent", () => {
    assert.equal(permissionInputText("{\"command\":\"ls\"}"), "{\n  \"command\": \"ls\"\n}");
    assert.equal(permissionInputText("{\"command\":\"ls -la…"), "{\"command\":\"ls -la…");
  });
});
