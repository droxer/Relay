import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { applySessionEvent } from "../src/lib/sessionEvents.js";
import { threadAwaitsHuman } from "../src/lib/awaitingInput.js";
import { answersComplete, isQuestionPrompt, permissionInputSummary, permissionInputText, permissionNoteReachesAgent } from "../src/lib/permissionRequests.js";
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

  it("closes a question prompt with the person's answers, in replay and live alike", () => {
    const questions = [{ id: "Which?", text: "Which?", options: [{ label: "A" }, { label: "B" }], multiSelect: true }];
    const askedQuestion = relayEvent("agent.permission_requested", "ses_1", {
      request: { id: "perm_00000002", runId: "run_1", agent: "claude", toolName: "AskUserQuestion", input: "{}", questions },
    });
    const answered = relayEvent("agent.permission_resolved", "ses_1", { requestId: "perm_00000002", decision: "allow", answers: { "Which?": ["A", "B"] }, actorUserId: "user_1" });
    const open = both([started, askedQuestion]);
    for (const session of [open.replay, open.live]) {
      assert.deepEqual(session.permissionRequests?.[0].questions, questions);
      assert.equal(isQuestionPrompt(session.permissionRequests![0]), true);
    }
    const closed = both([started, askedQuestion, answered]);
    for (const session of [closed.replay, closed.live]) {
      assert.equal(session.permissionRequests, undefined);
      assert.deepEqual(closed.replay.permissionDecisions?.[0].answers, { "Which?": ["A", "B"] });
      assert.equal(session.permissionDecisions?.[0].decision, "allow");
    }
  });

  it("closes a withdrawn prompt as expired with the daemon's reason", () => {
    const withdrawn = relayEvent("agent.permission_resolved", "ses_1", { requestId: "perm_00000001", decision: "expired", note: "No one answered within 30 minutes." });
    const { replay, live } = both([started, asked, withdrawn]);
    for (const session of [replay, live]) {
      assert.equal(session.permissionRequests, undefined);
      assert.deepEqual(session.permissionDecisions?.map(({ decision, note }) => ({ decision, note })), [{ decision: "expired", note: "No one answered within 30 minutes." }]);
      assert.equal(threadAwaitsHuman(session, []), false);
    }
  });

  it("knows when every question has an answer, one each unless it allows several", () => {
    const request = { questions: [
      { id: "a", text: "A?", options: [{ label: "x" }] },
      { id: "b", text: "B?", options: [{ label: "y" }, { label: "z" }], multiSelect: true },
    ] };
    assert.equal(answersComplete(request, {}), false);
    assert.equal(answersComplete(request, { a: ["x"] }), false);
    assert.equal(answersComplete(request, { a: ["x"], b: ["y", "z"] }), true);
    assert.equal(answersComplete(request, { a: ["x", "own"], b: ["y"] }), false);
    assert.equal(answersComplete({ questions: [] }, {}), true);
    assert.equal(isQuestionPrompt({}), false);
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

describe("permissionInputSummary", () => {
  it("names what the tool acts on without changing its whitespace", () => {
    assert.equal(permissionInputSummary(JSON.stringify({ command: "python3 -I -c \"\n  print(1)\"", description: "Run" })), 'python3 -I -c "\n  print(1)"');
    assert.equal(permissionInputSummary(JSON.stringify({ file_path: "/repo/a.ts", content: "x" })), "/repo/a.ts");
    assert.equal(permissionInputSummary(JSON.stringify({ server: "github", issue: 4 })), '{"server":"github","issue":4}');
  });

  it("says nothing for an empty input and keeps a capped preview as is", () => {
    assert.equal(permissionInputSummary("{}"), undefined);
    assert.equal(permissionInputSummary(""), undefined);
    assert.equal(permissionInputSummary(undefined), undefined);
    assert.equal(permissionInputSummary('{"command": "ls -la'), '{"command": "ls -la');
  });

  it("preserves long commands that differ after a shared prefix", () => {
    const prefix = "# setup\n".repeat(40);
    for (const suffix of ["printf first", "printf second"]) {
      const command = prefix + suffix;
      assert.equal(permissionInputSummary(JSON.stringify({ command })), command);
    }
  });

  it("preserves quoted spaces, tabs, and newlines exactly", () => {
    for (const command of ["printf '%s' 'a  b'", "printf '%s' 'a b'", "cat <<'EOF'\n\tindented  text\nEOF"]) {
      assert.equal(permissionInputSummary(JSON.stringify({ command })), command);
    }
  });
});
