import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import type { TFunction } from "i18next";

import { isGroupedContinuation, phaseDividerLabel, projectMessages, ProjectMessagesAccumulator } from "../src/lib/projectMessages.js";
import {
  buildExecutorDisplayNameMap,
  buildLogicalAgentNameMap,
  labelForAgentRun,
} from "../src/lib/agentDisplayNames.js";
import { rerunAssignmentForSession } from "../src/lib/workflow.js";
import { runReceipt } from "../src/lib/runReceipt.js";
import type { RelaySession } from "../src/types.js";
import { parseAgentStream } from "../src/lib/agentStream.js";
import { truncateAgentTranscript } from "../../packages/relay-core/src/transcript.js";

const timestamp = "2026-06-19T12:00:00.000Z";

const t = ((key: string, options?: Record<string, unknown>) => {
  if (key === "message.artifact") return `Artifact - ${String(options?.kind)}`;
  if (key.startsWith("artifact.kind.")) return String(options?.defaultValue ?? key.split(".").at(-1));
  if (key === "transcript.phase_agent") return "Agent";
  if (key === "transcript.phase_handoff") return "Handoff";
  if (key.startsWith("mode.")) return String(key.split(".").at(-1));
  return key;
}) as unknown as TFunction;

function session(events: RelaySession["events"]): RelaySession {
  return {
    id: "ses_1",
    workspacePath: "/workspace",
    ownerUserId: "alice",
    taskGoal: "Build artifact display",
    participants: ["human", "claude"],
    status: "running",
    phase: "running",
    createdAt: timestamp,
    updatedAt: timestamp,
    currentAgent: "codex",
    agentRuns: [],
    artifacts: [],
    decisions: [],
    collaborationRounds: [],
    events,
  };
}

describe("ProjectMessagesAccumulator", () => {
  it("preserves settled message identities while applying an appended event suffix", () => {
    const projector = new ProjectMessagesAccumulator();
    const started = {
      id: "ev_started",
      type: "agent.started" as const,
      sessionId: "ses_1",
      timestamp,
      runId: "run_1",
      agent: "codex" as const,
    };
    const first = projector.update(session([started]), t);
    const second = projector.update(session([
      started,
      {
        id: "ev_output",
        type: "agent.output",
        sessionId: "ses_1",
        timestamp,
        runId: "run_1",
        agent: "codex",
        stream: "stdout",
        text: "hello",
        sequence: 0,
      },
    ]), t);

    assert.equal(second[0], first[0]);
    assert.notEqual(second[1], first[1]);
    assert.equal(second[1]?.kind === "agent" ? second[1].stdout : "", "hello");
  });

  it("projects an ordered output batch in one update", () => {
    const projected = new ProjectMessagesAccumulator().update(session([
      {
        id: "ev_output_batch",
        type: "agent.output.batch",
        sessionId: "ses_1",
        timestamp,
        runId: "run_1",
        agent: "codex",
        entries: [
          { stream: "stdout", text: "out-1", sequence: 0 },
          { stream: "stderr", text: "err-1", sequence: 1 },
          { stream: "stdout", text: "out-2", sequence: 2 },
        ],
      },
    ]), t);

    assert.equal(projected[1]?.kind === "agent" ? projected[1].stdout : "", "out-1out-2");
    assert.equal(projected[1]?.kind === "agent" ? projected[1].stderr : "", "err-1");
  });

  it("reconciles late Antigravity deltas with the completed log and keeps new output", () => {
    const projector = new ProjectMessagesAccumulator();
    const run = { sessionId: "ses_1", timestamp, runId: "run_1", agent: "antigravity" as const };
    const frame = (text: string) => JSON.stringify({ type: "text", delta: true, part: { type: "text", text } }) + "\n";
    const first = frame("Start. ");
    const restored = frame("End.");
    const events: RelaySession["events"] = [
      { ...run, id: "first", type: "agent.output", stream: "stdout", text: first, sequence: 0 },
      { ...run, id: "done", type: "agent.completed", status: "completed", exitCode: 0,
        agentLog: `stdout:\n${first}${restored}`, outputTruncated: true },
    ];
    const reply = () => {
      const message = projector.update(session(events), t).at(-1);
      assert.ok(message?.kind === "agent");
      return parseAgentStream("antigravity", message.stdout);
    };
    assert.deepEqual(reply(), [{ kind: "text", text: "Start. End." }]);
    events.push({ ...run, id: "late", type: "agent.output", stream: "stdout", text: restored.slice(0, 20), sequence: 1 });
    assert.deepEqual(reply(), [{ kind: "text", text: "Start. End." }]);
    events.push({ ...run, id: "latest", type: "agent.output.batch", entries: [
      { stream: "stdout", text: restored.slice(20) + restored, sequence: 2 },
    ] });
    assert.deepEqual(reply(), [{ kind: "text", text: "Start. End.End." }]);
  });

  describe("Antigravity transcript recovery", () => {
    const run = { sessionId: "ses_1", timestamp, runId: "run_1", agent: "antigravity" as const };
    const frame = (type: string, part: Record<string, unknown>) =>
      JSON.stringify({ type, delta: true, part }) + "\n";
    const output = (sequence: number, text: string) =>
      ({ ...run, id: `out-${sequence}`, type: "agent.output" as const, stream: "stdout" as const, text, sequence });
    const completed = (log: string, outputTruncated = false) =>
      ({ ...run, id: "done", type: "agent.completed" as const, status: "completed" as const,
        exitCode: 0, agentLog: `stdout:\n${log}`, outputTruncated });
    const rendered = (messages: ReturnType<typeof projectMessages>) =>
      messages.flatMap((message) => message.kind === "agent"
        ? [parseAgentStream("antigravity", message.stdout)] : []);

    it("keeps a full reply once when its completion log retained only the ends", () => {
      const head = frame("text", { text: "Start. " });
      const middle = "Details. ".repeat(80);
      const rest = frame("text", { text: middle }) + frame("text", { text: "End." });
      const fallback = truncateAgentTranscript(head + rest, 220);
      assert.match(fallback, /output omitted/);
      const expected = [[{ kind: "text", text: `Start. ${middle}End.` }]];
      assert.deepEqual(rendered(projectMessages(session([output(0, head + rest), completed(fallback)]), t)), expected);

      const projector = new ProjectMessagesAccumulator();
      const events: RelaySession["events"] = [output(0, head), completed(fallback, true)];
      assert.match(JSON.stringify(rendered(projector.update(session(events), t))), /End\./);
      events.push(output(1, rest));
      assert.deepEqual(rendered(projector.update(session(events), t)), expected);
    });

    it("puts the recovered opening before surviving middle output", () => {
      const head = frame("text", { text: "Opening." });
      const lost = frame("text", { text: "Lost. ".repeat(80) });
      const middle = frame("text", { text: "Surviving middle. " });
      const tail = frame("text", { text: "Ending." });
      const fallback = truncateAgentTranscript(head + lost + middle + tail, 220);
      const messages = projectMessages(session([output(2, middle + tail), completed(fallback, true)]), t);
      assert.deepEqual(rendered(messages), [[
        { kind: "text", text: "Opening." },
        { kind: "text", text: "[... output omitted ...]" },
        { kind: "text", text: "Surviving middle. Ending." },
      ]]);
    });

    it("restores tool and reasoning frames even when the streamed reply already matches", () => {
      const reply = frame("text", { text: "Done." });
      const reasoning = frame("reasoning", { text: "Checking the README." });
      const tool = frame("tool_use", { callID: "read", tool: "read_file", state: { status: "completed" } });
      const activity = [{ kind: "thinking", text: "Checking the README." }, { kind: "tool", id: "read", name: "read_file" }];
      assert.deepEqual(rendered(projectMessages(session([completed(reasoning + tool, true)]), t)), [activity]);
      assert.deepEqual(rendered(projectMessages(session([output(0, reply), completed(reasoning + tool + reply, true)]), t)), [
        [...activity, { kind: "text", text: "Done." }],
      ]);
    });

    it("updates the original tool row when its result lands after a steering message", () => {
      const opening = frame("tool_use", { callID: "read", tool: "read_file", state: { status: "running" } });
      const result = frame("tool_use", { callID: "read", tool: "read_file",
        state: { status: "error", title: "README.md", error: "File unavailable" } });
      const reply = frame("text", { text: "I moved on." });
      const events: RelaySession["events"] = [
        output(0, opening),
        { ...run, id: "asked", type: "agent.permission_requested",
          request: { ...run, id: "permit", input: "{}", toolName: "read_file", toolUseId: "read" } },
        { ...run, id: "steer", type: "user.live_message", text: "Skip this file.", delivery: "steer" },
        { ...run, id: "denied", type: "agent.permission_resolved", requestId: "permit", decision: "deny" },
      ];
      const projector = new ProjectMessagesAccumulator();
      projector.update(session(events), t);
      events.push(output(1, result.slice(0, 30)));
      projector.update(session(events), t);
      events.push(output(2, result.slice(30) + reply));
      const expected = [
        [
          { kind: "tool", id: "read", name: "read_file", target: "README.md" },
          { kind: "status", scope: "tool", tone: "bad", text: "File unavailable" },
        ],
        [{ kind: "text", text: "I moved on." }],
      ];
      assert.deepEqual(rendered(projector.update(session(events), t)), expected);
      events.push(completed(opening + result + reply));
      const settled = projector.update(session(events), t);
      assert.deepEqual(rendered(settled), expected);
      const turns = settled.filter((message) => message.kind === "agent");
      assert.deepEqual(turns.map((message) => message.permissions?.map((audit) => audit.outcome)), [["deny"], undefined]);
    });

    it("keeps steering boundaries when the completion log restores earlier frames", () => {
      const head = frame("text", { text: "Opening. " });
      const reasoning = frame("reasoning", { text: "Before steering." });
      const before = frame("text", { text: "Working." });
      const after = frame("text", { text: "Redirected." });
      const events: RelaySession["events"] = [
        output(0, head), output(2, before),
        { ...run, id: "steer", type: "user.live_message", text: "Redirect.", delivery: "steer" },
        completed(head + reasoning + before + after, true),
        output(3, after),
      ];
      assert.deepEqual(rendered(projectMessages(session(events), t)), [
        [{ kind: "text", text: "Opening. " }, { kind: "thinking", text: "Before steering." }, { kind: "text", text: "Working." }],
        [{ kind: "text", text: "Redirected." }],
      ]);
    });
  });

  it("shows a message sent into a running turn as the person's, marked live", () => {
    const projected = new ProjectMessagesAccumulator().update(session([
      { id: "ev_out", type: "agent.output", sessionId: "ses_1", timestamp, runId: "run_1", agent: "codex", stream: "stdout", text: "Working." },
      {
        id: "live_q1", type: "user.live_message", sessionId: "ses_1", timestamp,
        text: "Use the staging database.", runId: "run_1", agent: "codex", delivery: "steer",
      },
    ]), t);

    const live = projected.find((message) => message.kind === "user" && message.live);
    assert.equal(live?.kind === "user" ? live.text : "", "Use the staging database.");
  });

  it("continues a run's output after a live message instead of above it", () => {
    const later = "2026-06-19T12:00:05.000Z";
    const done = "2026-06-19T12:00:09.000Z";
    const projected = new ProjectMessagesAccumulator().update(session([
      { id: "ev_start", type: "agent.started", sessionId: "ses_1", timestamp, runId: "run_1", agent: "codex", logicalAgentId: "agent_a" },
      { id: "ev_out", type: "agent.output", sessionId: "ses_1", timestamp, runId: "run_1", agent: "codex", stream: "stdout", text: "line one\nhalf a li" },
      {
        id: "live_q1", type: "user.live_message", sessionId: "ses_1", timestamp: later,
        text: "Use the staging database.", runId: "run_1", agent: "codex", delivery: "steer",
      },
      { id: "ev_out2", type: "agent.output", sessionId: "ses_1", timestamp: later, runId: "run_1", agent: "codex", stream: "stdout", text: "ne\nSwitching to staging.\n" },
      { id: "ev_done", type: "agent.completed", sessionId: "ses_1", timestamp: done, runId: "run_1", agent: "codex", status: "completed" },
    ] as RelaySession["events"]), t);

    assert.deepEqual(projected.map((message) => message.kind), ["user", "agent", "user", "agent"]);
    const [, before, live, after] = projected;
    assert.equal(live.kind === "user" ? live.live : undefined, true);
    assert.ok(before.kind === "agent" && after.kind === "agent");
    if (before.kind !== "agent" || after.kind !== "agent") return;
    // The cut falls on a line boundary, so a record streamed in halves stays whole.
    assert.equal(before.stdout, "line one\n");
    assert.equal(before.continued, true);
    assert.equal(before.streaming, false);
    assert.equal(before.outcome, undefined);
    assert.equal(after.stdout, "half a line\nSwitching to staging.\n");
    assert.equal(after.runId, "run_1");
    assert.equal(after.agentId, "agent_a");
    assert.notEqual(after.id, before.id);
    assert.equal(after.outcome, "completed");
    assert.equal(after.runStartedAt, timestamp);
    assert.equal(runReceipt(after)?.durationMs, 9000);
    // The block after the message reads as a new speaker turn, not a grouped tail.
    assert.equal(isGroupedContinuation(projected, 3), false);
  });

  it("keeps a run in one block when the live message arrives after it finished", () => {
    const projected = new ProjectMessagesAccumulator().update(session([
      { id: "ev_out", type: "agent.output", sessionId: "ses_1", timestamp, runId: "run_1", agent: "codex", stream: "stdout", text: "Done.\n" },
      { id: "ev_done", type: "agent.completed", sessionId: "ses_1", timestamp, runId: "run_1", agent: "codex", status: "completed" },
      {
        id: "live_q1", type: "user.live_message", sessionId: "ses_1", timestamp,
        text: "Too late.", runId: "run_1", agent: "codex", delivery: "steer",
      },
    ] as RelaySession["events"]), t);

    assert.deepEqual(projected.map((message) => message.kind), ["user", "agent", "user"]);
    assert.equal(projected[1]?.kind === "agent" ? projected[1].continued : true, undefined);
  });

  it("does not replay the earlier block when the completed log restores the whole run", () => {
    const projected = new ProjectMessagesAccumulator().update(session([
      { id: "ev_out", type: "agent.output", sessionId: "ses_1", timestamp, runId: "run_1", agent: "claude", stream: "stdout", text: "First part.\n" },
      {
        id: "live_q1", type: "user.live_message", sessionId: "ses_1", timestamp,
        text: "Also check logs.", runId: "run_1", agent: "claude", delivery: "follow-up",
      },
      {
        id: "ev_done", type: "agent.completed", sessionId: "ses_1", timestamp, runId: "run_1", agent: "claude",
        status: "completed", agentLog: "stdout:\nFirst part.\nChecked the logs.\n",
      },
    ] as RelaySession["events"]), t);

    const after = projected.at(-1);
    assert.equal(after?.kind === "agent" ? after.stdout : "", "Checked the logs.\n");
  });
});

describe("memoized transcript messages", () => {
  it("passes a stable artifact callback to MessageBlock", () => {
    const source = readFileSync("web/src/AuthenticatedApp.tsx", "utf8");

    assert.match(source, /const handleOpenThreadSpace = useStableEvent\(/);
    assert.match(source, /onOpenArtifacts=\{handleOpenThreadSpace\}/);
  });

  it("resolves append-vs-create before requiring a locally routable agent", () => {
    // Moved to hooks/useThreadDispatch when App.tsx was broken up.
    const source = readFileSync("web/src/hooks/useThreadDispatch.ts", "utf8");
    const actionIndex = source.indexOf("const action = composingNew");
    const routingGateIndex = source.indexOf("const messageAddress = resolveThreadMessageAddress");

    assert.ok(actionIndex >= 0);
    assert.ok(routingGateIndex >= 0);
    assert.ok(actionIndex < routingGateIndex);
  });

  it("retains operation ids for rerun and handoff recovery retries", () => {
    const source = readFileSync("web/src/hooks/useThreadDispatch.ts", "utf8");

    // Rerun, retry and handoff share ONE dispatch path. They used to be three
    // copies that each had to spell the `${sessionId}:kind:${agentId}` key the
    // same way by hand; if two drifted, a retried turn minted a second
    // operation id for work the backend had already accepted. Assert the
    // single path, not the three copies.
    assert.match(source, /recoveryOperationIdsRef/);
    assert.match(source, /idempotencyKey: recoveryOperationId\(recoveryKey\)/);
    // Image-bearing new messages also have an idempotency key; they are not
    // recovery requests. Keep the single-path assertion scoped to recovery.
    const recoverySource = source.slice(source.indexOf("async function dispatchRecovery("), source.indexOf("async function sendDecision("));
    assert.equal(
      recoverySource.match(/idempotencyKey:/g)?.length,
      1,
      "only dispatchRecovery may mint a recovery idempotency key",
    );
    // Both recovery kinds still route through it.
    for (const kind of ["rerun", "handoff"]) {
      assert.match(source, new RegExp(`kind: "${kind}",\\n\\s*(note:[^\\n]*\\n\\s*)?failureLabel`));
    }
    // And the handoff target stays an explicit pick — no executor-kind fallback.
    const handoff = source.slice(source.indexOf("async function sendHandoff()"));
    assert.doesNotMatch(handoff.slice(0, 400), /fallback:/);
  });
});

describe("projectMessages permission audits", () => {
  function audits(messages: ReturnType<typeof projectMessages>) {
    const turn = messages.find((message) => message.kind === "agent");
    return turn?.kind === "agent" ? turn.permissions ?? [] : [];
  }

  it("keeps complete, exact commands available after approval", () => {
    const prefix = "# shared setup\n".repeat(30);
    const commands = [prefix + "printf '%s' 'a  b'", prefix + "printf '%s' 'a b'"];
    const events = commands.flatMap((command, index): RelaySession["events"] => [
      { id: `ask_${index}`, type: "agent.permission_requested", sessionId: "ses_1", timestamp, request: { id: `perm_${index}`, runId: "run_1", agent: "claude", toolName: "Bash", input: JSON.stringify({ command }) } },
      { id: `allow_${index}`, type: "agent.permission_resolved", sessionId: "ses_1", timestamp, requestId: `perm_${index}`, decision: "allow" },
    ]);
    // No turn to join: the audit stays a line of its own.
    const lines = projectMessages(session(events), t).filter((message) => message.kind === "system");
    assert.deepEqual(lines.map((line) => line.detail), commands);
  });

  it("joins each audit to the turn that asked instead of a separate list", () => {
    const messages = projectMessages(session([
      { id: "ev_run", type: "agent.started", sessionId: "ses_1", timestamp, runId: "run_1", agent: "claude" },
      { id: "ev_ask", type: "agent.permission_requested", sessionId: "ses_1", timestamp, request: { id: "perm_1", runId: "run_1", agent: "claude", toolName: "Bash", toolUseId: "toolu_1", input: JSON.stringify({ command: "git fetch --prune\n  origin", description: "Fetch" }) } },
      { id: "ev_ask_edit", type: "agent.permission_requested", sessionId: "ses_1", timestamp, request: { id: "perm_3", runId: "run_1", agent: "claude", toolName: "Edit", input: JSON.stringify({ file_path: "/repo/a.ts", old_string: "x" }) } },
      { id: "ev_ask_bare", type: "agent.permission_requested", sessionId: "ses_1", timestamp, request: { id: "perm_4", runId: "run_1", agent: "claude", toolName: "Read", input: "{}" } },
      { id: "ev_q", type: "agent.permission_requested", sessionId: "ses_1", timestamp, request: { id: "perm_2", runId: "run_1", agent: "claude", toolName: "AskUserQuestion", input: "{}", questions: [{ id: "Which?", text: "Which?", options: [{ label: "A" }] }] } },
      { id: "ev_deny", type: "agent.permission_resolved", sessionId: "ses_1", timestamp, requestId: "perm_1", decision: "deny", note: "Not that" },
      { id: "ev_answer", type: "agent.permission_resolved", sessionId: "ses_1", timestamp, requestId: "perm_2", decision: "allow", answers: { "Which?": ["A"] } },
      { id: "ev_allow_edit", type: "agent.permission_resolved", sessionId: "ses_1", timestamp, requestId: "perm_3", decision: "allow" },
      { id: "ev_expire_bare", type: "agent.permission_resolved", sessionId: "ses_1", timestamp, requestId: "perm_4", decision: "expired" },
      { id: "ev_stale", type: "agent.permission_resolved", sessionId: "ses_1", timestamp, requestId: "perm_unknown", decision: "allow" },
    ]), t);
    assert.equal(messages.filter((message) => message.kind === "system").length, 0);
    assert.deepEqual(audits(messages).map((audit) => [audit.outcome, audit.label, audit.detail, audit.tone, audit.target, audit.toolUseId]), [
      ["deny", "message.permission_deny", "git fetch --prune\n  origin · Not that", "warn", "git fetch --prune", "toolu_1"],
      ["answered", "message.permission_answered", "A", "info", undefined, undefined],
      ["allow", "message.permission_allow", "/repo/a.ts", "info", "/repo/a.ts", undefined],
      ["expired", "message.permission_expired", undefined, "neutral", undefined, undefined],
    ]);
  });

  it("names a person's always allow, and an allow a standing grant gave", () => {
    const messages = projectMessages(session([
      { id: "ev_run", type: "agent.started", sessionId: "ses_1", timestamp, runId: "run_1", agent: "claude" },
      { id: "ev_ask", type: "agent.permission_requested", sessionId: "ses_1", timestamp, request: { id: "perm_1", runId: "run_1", agent: "claude", toolName: "Bash", input: "{}" } },
      { id: "ev_always", type: "agent.permission_resolved", sessionId: "ses_1", timestamp, requestId: "perm_1", decision: "allow", always: true, actorUserId: "user_1" },
      { id: "ev_ask2", type: "agent.permission_requested", sessionId: "ses_1", timestamp, request: { id: "perm_2", runId: "run_1", agent: "claude", toolName: "Bash", input: "{}" } },
      { id: "ev_grant", type: "agent.permission_resolved", sessionId: "ses_1", timestamp, requestId: "perm_2", decision: "allow", grant: true },
    ]), t);
    assert.deepEqual(audits(messages).map((audit) => [audit.outcome, audit.label, audit.tone]), [
      ["allow_always", "message.permission_allow_always", "info"],
      ["allow_granted", "message.permission_allow_granted", "info"],
    ]);
  });
});

describe("projectMessages artifact projection", () => {
  it("attaches structured collaboration events to the matching run", () => {
    const collaboration = {
      id: "collab-1",
      tool: "spawnAgent" as const,
      status: "completed" as const,
      senderThreadId: "root-thread",
      receiverThreadIds: ["child-thread"],
      prompt: "Review the protocol",
      model: null,
      reasoningEffort: null,
      agentsStates: {
        "child-thread": { status: "running" as const, message: "Reading tests" },
      },
    };
    const messages = projectMessages(session([
      {
        id: "ev_run",
        type: "agent.started",
        sessionId: "ses_1",
        timestamp,
        runId: "run_1",
        agent: "codex",
        role: "implementer",
      },
      {
        id: "ev_collab",
        type: "agent.collaboration",
        sessionId: "ses_1",
        timestamp,
        runId: "run_1",
        agent: "codex",
        sequence: 1,
        collaboration,
      },
    ]), t);

    const agent = messages.find((message) => message.kind === "agent");
    assert.ok(agent && agent.kind === "agent");
    assert.deepEqual(agent.collaborations, [collaboration]);
  });

  it("attaches visible artifacts to the matching agent run and hides command logs", () => {
    const messages = projectMessages(session([
      {
        id: "ev_created",
        type: "session.created",
        sessionId: "ses_1",
        timestamp,
        workspacePath: "/workspace",
        taskGoal: "Build artifact display",
        participants: ["human", "claude"],
      },
      {
        id: "ev_run_a",
        type: "agent.started",
        sessionId: "ses_1",
        timestamp,
        runId: "run_a",
        agent: "claude",
        role: "implementer",
      },
      {
        id: "ev_plan",
        type: "artifact.created",
        sessionId: "ses_1",
        timestamp,
        artifact: {
          id: "art_plan",
          kind: "plan",
          title: "Assignment plan",
          path: "/tmp/art_plan.json",
          createdAt: timestamp,
          agentRunId: "run_a",
          bytes: 128,
        },
      },
      {
        id: "ev_run_b",
        type: "agent.started",
        sessionId: "ses_1",
        timestamp,
        runId: "run_b",
        agent: "codex",
        role: "reviewer",
      },
      {
        id: "ev_review",
        type: "artifact.created",
        sessionId: "ses_1",
        timestamp,
        artifact: {
          id: "art_review",
          kind: "review",
          title: "Codex review",
          path: "/tmp/art_review.txt",
          createdAt: timestamp,
          agentRunId: "run_b",
          bytes: 256,
        },
      },
      {
        id: "ev_deck",
        type: "artifact.created",
        sessionId: "ses_1",
        timestamp,
        artifact: {
          id: "art_deck",
          kind: "workspace_file",
          title: "Quarterly review.pptx",
          path: "/workspace/Quarterly review.pptx",
          createdAt: timestamp,
          agentRunId: "run_b",
          bytes: 4096,
          contentType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
          workspaceRelativePath: "Quarterly review.pptx",
        },
      },
      {
        id: "ev_command_log",
        type: "artifact.created",
        sessionId: "ses_1",
        timestamp,
        artifact: {
          id: "art_log",
          kind: "command_log",
          title: "Codex raw output",
          path: "/tmp/art_log.txt",
          createdAt: timestamp,
          agentRunId: "run_b",
          bytes: 512,
        },
      },
    ]), t);

    const agentMessages = messages.filter((message) => message.kind === "agent");
    assert.equal(agentMessages.length, 2);
    assert.deepEqual(agentMessages.map((message) => message.attachments.map((artifact) => artifact.id)), [
      ["art_plan"],
      ["art_review", "art_deck"],
    ]);
  });

  it("renders runless artifacts as standalone system rows", () => {
    const messages = projectMessages(session([
      {
        id: "ev_summary",
        type: "artifact.created",
        sessionId: "ses_1",
        timestamp,
        artifact: {
          id: "art_summary",
          kind: "summary",
          title: "Session summary",
          path: "/tmp/art_summary.md",
          createdAt: timestamp,
          bytes: 64,
        },
      },
    ]), t);

    const system = messages.find((message) => message.kind === "system");
    assert.ok(system);
    assert.equal(system.id, "ev_summary");
    assert.equal(system.detail, "Session summary");
    // The row carries the artifact so the transcript can render its card.
    assert.equal(system.kind === "system" ? system.artifact?.id : undefined, "art_summary");
  });

  it("associates generated files after the transcript has loaded their producing turn", () => {
    const created = {
      id: "ev_file", type: "artifact.created", sessionId: "ses_1", timestamp,
      artifact: {
        id: "f", kind: "workspace_file", title: "report.md", path: "/workspace/report.md",
        createdAt: timestamp, agentRunId: "run_a",
      },
    } as const;
    assert.deepEqual(projectMessages({ ...session([created]), eventStart: 2 }, t), []);
    const hydrated = projectMessages(session([
      { id: "started", type: "agent.started", sessionId: "ses_1", timestamp, runId: "run_a", agent: "codex" },
      created,
    ]), t);
    assert.deepEqual(hydrated.find(message => message.kind === "agent")?.attachments, [created.artifact]);
  });

  it("carries runless plan artifacts so the plan card can render", () => {
    // Assignment plans are created before any agent run exists (no
    // agentRunId); they must still reach the UI as artifacts, not just as a
    // label line, so PlanCard renders the step summary.
    const messages = projectMessages(session([
      {
        id: "ev_plan_runless",
        type: "artifact.created",
        sessionId: "ses_1",
        timestamp,
        artifact: {
          id: "art_plan_runless",
          kind: "plan",
          title: "Assignment plan",
          path: "/tmp/art_plan.json",
          createdAt: timestamp,
          bytes: 128,
        },
      },
    ]), t);

    const system = messages.find((message) => message.kind === "system");
    assert.ok(system && system.kind === "system");
    assert.equal(system.artifact?.kind, "plan");
    assert.equal(system.artifact?.id, "art_plan_runless");
  });

  it("renders a follow-up user.message as a user turn after the goal", () => {
    const messages = projectMessages(session([
      {
        id: "ev_created",
        type: "session.created",
        sessionId: "ses_1",
        timestamp,
        workspacePath: "/workspace",
        taskGoal: "Build artifact display",
        participants: ["human", "claude"],
      },
      {
        id: "ev_followup",
        type: "user.message",
        sessionId: "ses_1",
        timestamp,
        text: "Now add a dark mode toggle",
      },
    ]), t);

    const userMessages = messages.filter((message) => message.kind === "user");
    assert.equal(userMessages.length, 2);
    assert.equal(userMessages[0].text, "Build artifact display");
    assert.equal(userMessages[1].id, "ev_followup");
    assert.equal(userMessages[1].text, "Now add a dark mode toggle");
  });

  it("offers resume only for an unfinished turn whose runtime reported its conversation", () => {
    const turn = (runId: string, status: "completed" | "failed" | "cancelled", runtimeSessionId?: string) => [
      { id: `ev_start_${runId}`, type: "agent.started", sessionId: "ses_1", timestamp, runId, agent: "claude", role: "fixer" },
      { id: `ev_done_${runId}`, type: "agent.completed", sessionId: "ses_1", timestamp, runId, agent: "claude",
        status, exitCode: status === "completed" ? 0 : 1, agentLog: "", ...(runtimeSessionId ? { runtimeSessionId } : {}) },
    ];
    const messages = projectMessages(session([
      ...turn("run_cut", "cancelled", "sess-12345678"),
      ...turn("run_failed", "failed", "sess-12345678"),
      ...turn("run_done", "completed", "sess-12345678"),
      ...turn("run_unknown", "failed"),
    ] as RelaySession["events"]), t);
    const turns = new Map(messages.flatMap((message) => message.kind === "agent" ? [[message.runId, message] as const] : []));
    assert.equal(turns.get("run_cut")?.resumable, true);
    assert.equal(turns.get("run_failed")?.resumable, true);
    assert.equal(turns.get("run_done")?.resumable, undefined);
    assert.equal(turns.get("run_unknown")?.resumable, undefined);
  });

  it("carries a truncated-output flag from the completed run onto its turn", () => {
    const messages = projectMessages(session([
      { id: "ev_start_cut", type: "agent.started", sessionId: "ses_1", timestamp, runId: "run_cut", agent: "codex", role: "fixer" },
      { id: "ev_done_cut", type: "agent.completed", sessionId: "ses_1", timestamp, runId: "run_cut", agent: "codex",
        status: "completed", exitCode: 0, agentLog: "", outputTruncated: true },
      { id: "ev_start_ok", type: "agent.started", sessionId: "ses_1", timestamp, runId: "run_ok", agent: "codex", role: "fixer" },
      { id: "ev_done_ok", type: "agent.completed", sessionId: "ses_1", timestamp, runId: "run_ok", agent: "codex",
        status: "completed", exitCode: 0, agentLog: "" },
    ] as RelaySession["events"]), t);
    const turns = new Map(messages.flatMap((message) => message.kind === "agent" ? [[message.runId, message] as const] : []));
    assert.equal(turns.get("run_cut")?.outputTruncated, true);
    assert.equal(turns.get("run_ok")?.outputTruncated, undefined);
  });

  it("marks every finished turn without counts as unreported and preserves reported usage", () => {
    const run = (runId: string, status: "completed" | "failed" | "cancelled", tokenUsage?: { input: number; output: number; cache: number; total: number }) => [
      { id: `ev_start_${runId}`, type: "agent.started", sessionId: "ses_1", timestamp, runId, agent: "opencode", role: "fixer" },
      {
        id: `ev_done_${runId}`, type: "agent.completed", sessionId: "ses_1", timestamp, runId, agent: "opencode",
        status, exitCode: status === "completed" ? 0 : 1, agentLog: "",
        ...(tokenUsage ? { tokenUsage } : {}),
      },
    ];
    const messages = projectMessages(session([
      ...(["completed", "failed", "cancelled"] as const).flatMap((status) => [
        ...run(`run_${status}`, status),
        ...run(`run_counted_${status}`, status, { input: 3, output: 2, cache: 0, total: 5 }),
      ]),
      { id: "ev_running", type: "agent.started", sessionId: "ses_1", timestamp, runId: "run_running", agent: "opencode", role: "fixer" },
    ] as RelaySession["events"]), t);
    const turns = new Map(messages.flatMap((message) => message.kind === "agent" ? [[message.runId, message] as const] : []));

    for (const status of ["completed", "failed", "cancelled"]) {
      assert.equal(turns.get(`run_${status}`)?.usageUnreported, true, status);
      assert.equal(turns.get(`run_${status}`)?.streaming, false, status);
      assert.equal(turns.get(`run_counted_${status}`)?.usageUnreported, undefined, status);
      assert.equal(turns.get(`run_counted_${status}`)?.tokenUsage?.total, 5, status);
    }
    assert.equal(turns.get("run_running")?.usageUnreported, undefined);
    assert.equal(turns.get("run_running")?.streaming, true);
  });

  it("does not fabricate an agent message for an unknown artifact run", () => {
    const messages = projectMessages(session([
      {
        id: "ev_unknown",
        type: "artifact.created",
        sessionId: "ses_1",
        timestamp,
        artifact: {
          id: "art_diff",
          kind: "diff",
          title: "Detached diff",
          path: "/tmp/art_diff.patch",
          createdAt: timestamp,
          agentRunId: "missing_run",
          bytes: 96,
        },
      },
    ]), t);

    assert.equal(messages.filter((message) => message.kind === "agent").length, 0);
    assert.equal(messages.filter((message) => message.kind === "system").length, 1);
  });

  it("renders Pi completed-log tails without leaking JSON or replaying the live reply", () => {
    const frame = `${JSON.stringify({ type: "message_end", message: {
      role: "assistant", content: [{ type: "text", text: "你好！我是 Jack。" }],
    } })}\n`;
    const clipped = '我是 Jack。\\n- 做验证。","index":0}],"api":"anthropic-messages","usage":{"input":42},"stopReason":"stop"}}\n';
    for (const streamed of ["", frame]) {
      const messages = projectMessages(session([
        { id: "ev_run", type: "agent.started", sessionId: "ses_1", timestamp, runId: "run_1", agent: "pi" },
        { id: "ev_output", type: "agent.output", sessionId: "ses_1", timestamp, runId: "run_1", agent: "pi", stream: "stdout", text: streamed },
        { id: "ev_completed", type: "agent.completed", sessionId: "ses_1", timestamp, runId: "run_1", agent: "pi",
          status: "completed", exitCode: 0, agentLog: `[Pi Action Exit 0]\nstdout:\n${clipped}${frame}` },
      ]), t);
      const agent = messages.find((message) => message.kind === "agent");
      assert.ok(agent && agent.kind === "agent");
      assert.equal(agent.streaming, false);
      assert.deepEqual(parseAgentStream(agent.agent, agent.stdout), [{ kind: "text", text: "你好！我是 Jack。" }]);
    }
  });

  for (const [agent, frames] of [
    ["pi", [{
      type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Saved reply." }] },
    }]],
    ["opencode", [
      { type: "text", delta: true, part: { messageID: "reply", text: "Saved " } },
      { type: "text", delta: true, part: { messageID: "reply", text: "reply." } },
    ]],
  ] as const) {
    it(`recovers a ${agent} reply from clean JSONL in the completed log`, () => {
      const stdout = frames.map((frame) => JSON.stringify(frame) + "\n").join("");
      const run = { sessionId: "ses_1", timestamp, runId: "run_1", agent };
      for (const live of ["", JSON.stringify(frames[0]) + "\n", stdout]) {
        const messages = projectMessages(session([
          { ...run, id: "started", type: "agent.started" },
          { ...run, id: "streamed", type: "agent.output", stream: "stdout", text: live },
          { ...run, id: "completed", type: "agent.completed", status: "completed", exitCode: 0, agentLog: `stdout:\n${stdout}` },
        ]), t);
        const message = messages.find((item) => item.kind === "agent");
        assert.ok(message?.kind === "agent");
        assert.deepEqual(parseAgentStream(agent, message.stdout), [{ kind: "text", text: "Saved reply." }]);
      }
    });
  }

  it("uses the completed agent log when streamed output missed the final answer", () => {
    const finalFrame = `${JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text: "Final answer from Codex." },
    })}\n${JSON.stringify({ type: "turn.completed" })}\n`;
    const messages = projectMessages(session([
      {
        id: "ev_run",
        type: "agent.started",
        sessionId: "ses_1",
        timestamp,
        runId: "run_1",
        agent: "codex",
        role: "implementer",
      },
      {
        id: "ev_output",
        type: "agent.output",
        sessionId: "ses_1",
        timestamp,
        runId: "run_1",
        agent: "codex",
        stream: "stdout",
        text: `${JSON.stringify({
          type: "item.started",
          item: { type: "command_execution", command: "npm test" },
        })}\n`,
      },
      {
        id: "ev_completed",
        type: "agent.completed",
        sessionId: "ses_1",
        timestamp,
        runId: "run_1",
        agent: "codex",
        status: "completed",
        exitCode: 0,
        agentLog: `[Codex Action Exit 0]\nstderr:\nReading additional input from stdin...\n\nstdout:\n${finalFrame}`,
      },
    ]), t);

    const agent = messages.find((message) => message.kind === "agent");
    assert.ok(agent && agent.kind === "agent");
    assert.equal(agent.streaming, false);
    assert.match(agent.stdout, /npm test/);
    assert.match(agent.stdout, /Final answer from Codex/);
    assert.match(agent.stderr, /Reading additional input/);
  });

  // A daemon that reports an agent log without the stdout:/stderr: markers
  // used to have every line filed as stderr, turning a clean run into a wall
  // of warn rows. Stream JSONL is agent output whether or not it is labelled.
  it("treats an unlabelled stream-json agent log as stdout", () => {
    const frame = `${JSON.stringify({
      type: "assistant",
      message: { id: "msg_1", content: [{ type: "text", text: "Unlabelled but streamed." }] },
    })}\n`;
    const messages = projectMessages(session([
      {
        id: "ev_run",
        type: "agent.started",
        sessionId: "ses_1",
        timestamp,
        runId: "run_1",
        agent: "claude",
        role: "implementer",
      },
      {
        id: "ev_completed",
        type: "agent.completed",
        sessionId: "ses_1",
        timestamp,
        runId: "run_1",
        agent: "claude",
        status: "completed",
        exitCode: 0,
        agentLog: frame,
      },
    ]), t);

    const agent = messages.find((message) => message.kind === "agent");
    assert.ok(agent && agent.kind === "agent");
    assert.match(agent.stdout, /Unlabelled but streamed/);
    assert.equal(agent.stderr, "");
  });

  it("keeps a Claude result-only completed log for the chat panel", () => {
    const frame = `${JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "Final response from cloud Claude.",
    })}\n`;
    const messages = projectMessages(session([
      {
        id: "ev_run",
        type: "agent.started",
        sessionId: "ses_1",
        timestamp,
        runId: "run_1",
        agent: "claude",
        role: "implementer",
      },
      {
        id: "ev_completed",
        type: "agent.completed",
        sessionId: "ses_1",
        timestamp,
        runId: "run_1",
        agent: "claude",
        status: "completed",
        exitCode: 0,
        agentLog: `stdout:\n${frame}`,
      },
    ]), t);

    const agent = messages.find((message) => message.kind === "agent");
    assert.ok(agent && agent.kind === "agent");
    assert.equal(agent.streaming, false);
    assert.equal(agent.stdout, frame);
    assert.equal(agent.stderr, "");
  });

  it("keeps an unlabelled non-stream agent log on stderr", () => {
    const messages = projectMessages(session([
      {
        id: "ev_run",
        type: "agent.started",
        sessionId: "ses_1",
        timestamp,
        runId: "run_1",
        agent: "claude",
        role: "implementer",
      },
      {
        id: "ev_completed",
        type: "agent.completed",
        sessionId: "ses_1",
        timestamp,
        runId: "run_1",
        agent: "claude",
        status: "failed",
        exitCode: 1,
        agentLog: "command not found: claude",
      },
    ]), t);

    const agent = messages.find((message) => message.kind === "agent");
    assert.ok(agent && agent.kind === "agent");
    assert.match(agent.stderr, /command not found/);
  });

  it("does not duplicate completed log output that was already streamed", () => {
    const finalFrame = `${JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text: "Already streamed." },
    })}\n`;
    const messages = projectMessages(session([
      {
        id: "ev_run",
        type: "agent.started",
        sessionId: "ses_1",
        timestamp,
        runId: "run_1",
        agent: "codex",
        role: "implementer",
      },
      {
        id: "ev_output",
        type: "agent.output",
        sessionId: "ses_1",
        timestamp,
        runId: "run_1",
        agent: "codex",
        stream: "stdout",
        text: finalFrame,
      },
      {
        id: "ev_completed",
        type: "agent.completed",
        sessionId: "ses_1",
        timestamp,
        runId: "run_1",
        agent: "codex",
        status: "completed",
        exitCode: 0,
        agentLog: `[Codex Action Exit 0]\nstdout:\n${finalFrame}`,
      },
    ]), t);

    const agent = messages.find((message) => message.kind === "agent");
    assert.ok(agent && agent.kind === "agent");
    assert.equal(agent.stdout.match(/Already streamed/g)?.length, 1);
  });

  it("carries reported token usage onto the completed agent turn", () => {
    const messages = projectMessages(session([
      {
        id: "ev_run",
        type: "agent.started",
        sessionId: "ses_1",
        timestamp,
        runId: "run_1",
        agent: "claude",
        role: "implementer",
      },
      {
        id: "ev_completed",
        type: "agent.completed",
        sessionId: "ses_1",
        timestamp,
        runId: "run_1",
        agent: "claude",
        status: "completed",
        exitCode: 0,
        tokenUsage: { input: 10, output: 4, cache: 1, total: 15 },
      },
    ]), t);

    const agent = messages.find((message) => message.kind === "agent");
    assert.ok(agent && agent.kind === "agent");
    assert.deepEqual(agent.tokenUsage, { input: 10, output: 4, cache: 1, total: 15 });
  });
});

describe("phaseDividerLabel", () => {
  it("does not add an agent divider after each user turn", () => {
    const messages = projectMessages(session([
      {
        id: "ev_run",
        type: "agent.started",
        sessionId: "ses_1",
        timestamp,
        runId: "run_1",
        agent: "claude",
        role: "implementer",
      },
    ]), t);

    const agentIndex = messages.findIndex((message) => message.kind === "agent");
    assert.equal(phaseDividerLabel(messages, agentIndex, t), null);
  });

  it("labels agent handoffs across different agents", () => {
    const messages = projectMessages(session([
      {
        id: "ev_run_a",
        type: "agent.started",
        sessionId: "ses_1",
        timestamp,
        runId: "run_a",
        agent: "claude",
        role: "implementer",
      },
      {
        id: "ev_run_b",
        type: "agent.started",
        sessionId: "ses_1",
        timestamp,
        runId: "run_b",
        agent: "codex",
        role: "reviewer",
      },
    ]), t);

    const codexIndex = messages.findIndex(
      (message) => message.kind === "agent" && message.agent === "codex",
    );
    assert.equal(phaseDividerLabel(messages, codexIndex, t), "Handoff");
  });
});

describe("logical agent identity in the transcript", () => {
  const agents = [
    {
      id: "agt_ada",
      userId: "alice",
      displayName: "Ada",
      executorKind: "claude" as const,
      skillPolicy: {},
      toolPolicy: {},
      modelPolicy: {},
      enabled: true,
      version: 1,
      availability: "ready" as const,
      placements: [],
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    {
      id: "agt_zoe",
      userId: "alice",
      displayName: "Zoe",
      executorKind: "claude" as const,
      skillPolicy: {},
      toolPolicy: {},
      modelPolicy: {},
      enabled: true,
      version: 1,
      availability: "ready" as const,
      placements: [],
      createdAt: timestamp,
      updatedAt: timestamp,
    },
  ];

  it("carries the logical agent that ran onto the derived turn", () => {
    const messages = projectMessages(session([
      {
        id: "ev_run",
        type: "agent.started",
        sessionId: "ses_1",
        timestamp,
        runId: "run_1",
        agent: "claude",
        logicalAgentId: "agt_zoe",
      },
    ]), t);

    const agent = messages.find((message) => message.kind === "agent");
    assert.ok(agent && agent.kind === "agent");
    assert.equal(agent.agentId, "agt_zoe");
  });

  it("keeps the logical agent when output arrives before agent.started", () => {
    const messages = projectMessages(session([
      {
        id: "ev_output",
        type: "agent.output",
        sessionId: "ses_1",
        timestamp,
        runId: "run_1",
        agent: "claude",
        stream: "stdout",
        text: "working\n",
      },
      {
        id: "ev_run",
        type: "agent.started",
        sessionId: "ses_1",
        timestamp,
        runId: "run_1",
        agent: "claude",
        logicalAgentId: "agt_zoe",
      },
    ]), t);

    const agent = messages.find((message) => message.kind === "agent");
    assert.ok(agent && agent.kind === "agent");
    assert.equal(agent.agentId, "agt_zoe");
  });

  it("labels a turn with the agent that ran, not the first agent on that executor", () => {
    const names = buildLogicalAgentNameMap(agents);
    const executorNames = buildExecutorDisplayNameMap(agents);
    assert.equal(
      labelForAgentRun({ agent: "claude", agentId: "agt_zoe" }, names, executorNames),
      "Zoe",
    );
  });

  it("falls back to the executor label for runs with no logical agent", () => {
    const names = buildLogicalAgentNameMap(agents);
    const executorNames = buildExecutorDisplayNameMap(agents);
    assert.equal(labelForAgentRun({ agent: "codex" }, names, executorNames), "Codex");
    assert.equal(
      labelForAgentRun({ agent: "claude", agentId: "agt_deleted" }, names, executorNames),
      "Ada",
    );
  });

  it("treats two agents on the same executor as separate turns", () => {
    const messages = projectMessages(session([
      {
        id: "ev_run_a",
        type: "agent.started",
        sessionId: "ses_1",
        timestamp,
        runId: "run_a",
        agent: "claude",
        logicalAgentId: "agt_ada",
      },
      {
        id: "ev_run_b",
        type: "agent.started",
        sessionId: "ses_1",
        timestamp,
        runId: "run_b",
        agent: "claude",
        logicalAgentId: "agt_zoe",
      },
    ]), t);

    const zoeIndex = messages.findIndex(
      (message) => message.kind === "agent" && message.agentId === "agt_zoe",
    );
    assert.equal(isGroupedContinuation(messages, zoeIndex), false);
    assert.equal(phaseDividerLabel(messages, zoeIndex, t), "Handoff");
  });

  it("shows a follow-up Relay started as its own turn, not more of the finished answer", () => {
    const messages = projectMessages(session([
      {
        id: "ev_run_a", type: "agent.started", sessionId: "ses_1", timestamp,
        runId: "run_a", agent: "claude", logicalAgentId: "agt_ada",
      },
      {
        id: "ev_run_b", type: "agent.started", sessionId: "ses_1", timestamp,
        runId: "run_b", agent: "claude", logicalAgentId: "agt_ada", followUp: "report_reminder",
      },
    ]), t);

    const reminderIndex = messages.findIndex((message) => message.kind === "agent" && message.runId === "run_b");
    const reminder = messages[reminderIndex];
    assert.equal(reminder.kind === "agent" && reminder.followUp, "report_reminder");
    assert.equal(isGroupedContinuation(messages, reminderIndex), false);
    const first = messages.find((message) => message.kind === "agent" && message.runId === "run_a");
    assert.equal(first?.kind === "agent" && first.followUp, undefined);
  });

  it("reruns the logical agent that produced the last turn", () => {
    const rerun = rerunAssignmentForSession(
      {
        ...session([]),
        agentRuns: [
          {
            id: "run_1",
            agent: "claude",
            status: "completed",
            startedAt: timestamp,
            artifactIds: [],
            logicalAgentId: "agt_zoe",
          },
        ],
      },
      "codex",
    );
    assert.deepEqual(rerun, { agent: "claude", agentId: "agt_zoe" });
  });
});

describe("isolated incremental projections", () => {
  it("does not let a discarded projection contaminate the committed transcript", () => {
    const base = { id: "isolated", taskGoal: "Goal", createdAt: timestamp, events: [] } as unknown as RelaySession;
    const committed = new ProjectMessagesAccumulator();
    const initial = committed.update(base, t);
    const discarded = committed.advance({ ...base, events: [{ id: "aborted", sessionId: base.id, type: "user.message", timestamp, text: "Discard me" }] }, t);
    assert.equal(discarded.messages.length, 2);
    assert.strictEqual(committed.update(base, t), initial);
    const next = committed.advance({ ...base, events: [{ id: "accepted", sessionId: base.id, type: "user.message", timestamp, text: "Keep me" }] }, t);
    assert.equal(next.messages.at(-1)?.kind, "user");
    assert.deepEqual(next.messages.filter((message) => message.kind === "user").map((message) => message.text), ["Goal", "Keep me"]);
  });
});
