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
import type { RelaySession } from "../src/types.js";

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
    ownerEmployeeId: "alice",
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
});

describe("memoized transcript messages", () => {
  it("passes a stable artifact callback to MessageBlock", () => {
    const source = readFileSync("web/src/App.tsx", "utf8");

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
    assert.equal(
      source.match(/idempotencyKey:/g)?.length,
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
      employeeId: "alice",
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
      employeeId: "alice",
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
