import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  appendOlderSessionPage,
  mergeSessionHeadPage,
  mergeSessionSnapshotIntoSessions,
  mergeSessionSummaries,
  sessionTrailsSummary,
  summaryEventCountOf,
} from "../src/lib/sessionPollMerge.js";
import { mergeSessionEventsIntoSessions } from "../src/lib/sessionEventMerge.js";
import type { RelaySession, SessionSummary } from "../src/types.js";
import { applySessionEventUnchecked, applySessionEventsUnchecked } from "../src/lib/sessionEvents.js";
import { threadAwaitsHuman } from "../src/lib/awaitingInput.js";

function session(partial: Partial<RelaySession> = {}): RelaySession {
  return {
    id: "ses_1",
    workspacePath: "/workspace",
    taskGoal: "stream smoothly",
    participants: ["human", "pi"],
    status: "running",
    phase: "pi:action",
    createdAt: "2026-06-20T00:00:00.000Z",
    updatedAt: "2026-06-20T00:00:00.000Z",
    agentRuns: [],
    artifacts: [],
    decisions: [],
    events: [],
    ...partial,
  } as RelaySession;
}

function summary(partial: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: "ses_1",
    workspacePath: "/workspace",
    taskGoal: "stream smoothly",
    status: "running",
    phase: "pi:action",
    createdAt: "2026-06-20T00:00:00.000Z",
    updatedAt: "2026-06-20T00:00:02.000Z",
    eventCount: 2,
    runCount: 1,
    artifactCount: 0,
    ...partial,
  };
}

describe("session poll merging", () => {
  it("keeps a resumed summary when a pre-resume detail or summary arrives late", () => {
    const blocked = session({ status: "completed", workOutcome: "blocked", events: [
      { id: "ended", type: "session.completed", sessionId: "ses_1", timestamp: "2026-06-20T00:00:01.000Z", outcome: "Needs input", workOutcome: "blocked" },
    ] });
    const running = mergeSessionSummaries([blocked], [summary({ eventCount: 2 })]);
    const afterDetail = mergeSessionSnapshotIntoSessions(running, blocked, applySessionEventUnchecked, applySessionEventsUnchecked);
    const afterSummary = mergeSessionSummaries(running, [summary({ status: "completed", workOutcome: "blocked", eventCount: 1 })]);

    for (const [current] of [afterDetail, afterSummary]) {
      assert.equal(current.status, "running");
      assert.equal(threadAwaitsHuman(current, []), false);
      assert.equal(sessionTrailsSummary(current), true);
    }
  });
  it("keeps a resumed summary visible while SSE replays an earlier blocked event", () => {
    const execution = { phase: "running" } as RelaySession["execution"];
    const running = mergeSessionSummaries([], [summary({ eventCount: 2, execution })]);
    const blocked: RelaySession["events"][number] = {
      id: "ended", type: "session.completed", sessionId: "ses_1", timestamp: "2026-06-20T00:00:01Z", outcome: "Needs input", workOutcome: "blocked",
    };
    const replay = (current: RelaySession[] | undefined, event: RelaySession["events"][number]) =>
      mergeSessionEventsIntoSessions(current, "ses_1", [event], applySessionEventUnchecked, applySessionEventsUnchecked).sessions!;
    const partial = replay(running, blocked);
    assert.deepEqual(partial[0].events, [blocked]);
    assert.equal(threadAwaitsHuman(partial[0], []), false);
    assert.equal(partial[0].status, "running");
    const complete = replay(partial, { id: "resumed", type: "session.status", sessionId: "ses_1", timestamp: "2026-06-20T00:00:02Z", status: "running", phase: "pi:action" });
    assert.equal(complete[0].status, "running");
    assert.equal(sessionTrailsSummary(complete[0]), false);
    assert.deepEqual(complete[0].execution, execution);

    const lateDetail = session({ status: "completed", workOutcome: "blocked", events: [blocked] });
    const [merged] = mergeSessionSnapshotIntoSessions(complete, lateDetail, applySessionEventUnchecked, applySessionEventsUnchecked);
    assert.deepEqual(merged.execution, execution);
  });
  it("applies new events after hydrating a replay in the same SSE batch", () => {
    const execution = { phase: "running" } as RelaySession["execution"];
    const [observed] = mergeSessionSummaries([], [summary({ eventCount: 1, execution })]);
    const updated = applySessionEventsUnchecked(observed, [
      { id: "resumed", type: "session.status", sessionId: "ses_1", timestamp: "2026-06-20T00:00:01Z", status: "running", phase: "pi:action" },
      { id: "renamed", type: "session.renamed", sessionId: "ses_1", timestamp: "2026-06-20T00:00:03Z", title: "New title" },
    ]);
    assert.deepEqual(updated.execution, execution);
    assert.equal(updated.title, "New title");
    assert.equal(updated.updatedAt, "2026-06-20T00:00:03Z");
    assert.equal(updated.events.length, 2);
  });
  it("preserves the summary permission during replay and applies a newer permission in the same batch", () => {
    const [observed] = mergeSessionSummaries([], [summary({ eventCount: 1, permissionMode: "ask" })]);
    const updated = applySessionEventsUnchecked(observed, [
      { id: "old", type: "session.permission_mode", mode: "yolo", actorUserId: "owner", sessionId: "ses_1", timestamp: "2026-06-20T00:00:01Z" },
      { id: "new", type: "session.permission_mode", mode: "yolo", actorUserId: "owner", sessionId: "ses_1", timestamp: "2026-06-20T00:00:03Z" },
    ]);
    assert.equal(applySessionEventsUnchecked(observed, [updated.events[0]]).permissionMode, "ask");
    assert.equal(updated.permissionMode, "yolo");
  });
  it("retains newer streamed outcomes and clears the old outcome when execution resumes", () => {
    const current = session({ status: "completed", workOutcome: "blocked", finalOutcome: "Old blocker", events: [
      { id: "ended", type: "session.completed", sessionId: "ses_1", timestamp: "now", outcome: "Needs input", workOutcome: "blocked" },
    ] });
    assert.equal(mergeSessionSummaries([current], [summary({ eventCount: 0 })])[0].workOutcome, "blocked");
    assert.equal(mergeSessionSummaries([current], [summary({ eventCount: 2, workOutcome: null })])[0].workOutcome, undefined);
    assert.equal(mergeSessionSummaries([], [summary({ status: "completed", workOutcome: "unfinished" })])[0].workOutcome, "unfinished");
    assert.equal(mergeSessionSummaries([current], [summary({ eventCount: 2, status: "completed", workOutcome: "reported_done" })])[0].finalOutcome, undefined);
  });
  it("carries each thread's room agents from the summary, not only the opened one", () => {
    const [inflated] = mergeSessionSummaries([], [summary({ participantAgentIds: ["agent_a", "agent_b"] })]);
    assert.deepEqual(inflated.participantAgentIds, ["agent_a", "agent_b"]);
    const [merged] = mergeSessionSummaries([session()], [summary({ participantAgentIds: ["agent_c"] })]);
    assert.deepEqual(merged.participantAgentIds, ["agent_c"]);
  });
  it("updates summary fields without replacing streamed event history", () => {
    const output = {
      id: "evt_output",
      type: "agent.output" as const,
      sessionId: "ses_1",
      timestamp: "2026-06-20T00:00:02.000Z",
      runId: "run_1",
      agent: "pi" as const,
      stream: "stdout" as const,
      text: "hello",
      sequence: 0,
    };
    const current = [session({ events: [output] })];

    const merged = mergeSessionSummaries(current, [summary({ title: "Renamed" })]);

    assert.equal(merged[0].title, "Renamed");
    assert.equal(merged[0].events, current[0].events);
  });

  it("marks a session whose events trail the summary until its detail catches up", () => {
    const current = [session({ events: [] })];

    const merged = mergeSessionSummaries(current, [summary({ eventCount: 2, status: "completed" })]);
    assert.equal(merged[0].status, "completed");
    assert.equal(summaryEventCountOf(merged[0]), 2);
    assert.equal(sessionTrailsSummary(merged[0]), true);

    const caughtUp = mergeSessionSummaries(current, [summary({ eventCount: 0 })]);
    assert.equal(sessionTrailsSummary(caughtUp[0]), false);
    assert.equal(sessionTrailsSummary(session()), false);
    assert.equal(sessionTrailsSummary(undefined), false);
  });

  it("clears the trailing mark when a fetched snapshot replaces the session", () => {
    const polled = mergeSessionSummaries([session()], [summary({ eventCount: 2, permissionMode: "ask" })]);
    const snapshot = session({ permissionMode: "ask", events: [
      { id: "e1", type: "session.permission_mode", mode: "ask", actorUserId: "owner", sessionId: "ses_1", timestamp: "2026-06-20T00:00:01Z" },
      { id: "e2", type: "session.status", status: "running", phase: "pi:action", sessionId: "ses_1", timestamp: "2026-06-20T00:00:02Z" },
    ] });
    const [refetched] = mergeSessionSnapshotIntoSessions(polled, snapshot);
    assert.equal(sessionTrailsSummary(refetched), false);
  });

  it("keeps the newer permission mode when an earlier detail or summary returns late", () => {
    const polled = mergeSessionSummaries([], [summary({ eventCount: 2, permissionMode: "ask" })]);
    const earlier = session({ permissionMode: "yolo", events: [
      { id: "e1", type: "session.permission_mode", mode: "yolo", actorUserId: "owner", sessionId: "ses_1", timestamp: "now" },
    ] });

    assert.equal(mergeSessionSnapshotIntoSessions(polled, earlier)[0].permissionMode, "ask");
    assert.equal(mergeSessionSummaries(polled, [summary({ eventCount: 1, permissionMode: "yolo" })])[0].permissionMode, "ask");
  });

  it("inflates a newly discovered summary until its detail is fetched", () => {
    const merged = mergeSessionSummaries([], [summary()]);

    assert.equal(merged[0].id, "ses_1");
    assert.deepEqual(merged[0].events, []);
    assert.deepEqual(merged[0].agentRuns, []);
  });

  it("does not roll live state back when a summary response predates SSE", () => {
    const output = {
      id: "evt_output",
      type: "agent.output" as const,
      sessionId: "ses_1",
      timestamp: "2026-06-20T00:00:03.000Z",
      runId: "run_1",
      agent: "pi" as const,
      stream: "stdout" as const,
      text: "newer",
      sequence: 0,
    };
    const current = [session({ events: [output], phase: "pi:action" })];

    const merged = mergeSessionSummaries(current, [summary({
      eventCount: 0,
      phase: "created",
      updatedAt: "2026-06-20T00:00:01.000Z",
    })]);

    assert.equal(merged[0], current[0]);
    assert.equal(merged[0].phase, "pi:action");
  });

  it("keeps the workspace artifact count a summary reports", () => {
    // The board counts a task's produced files from this number; discarding it
    // left the backlog with no way to say what a run produced.
    const merged = mergeSessionSummaries([], [summary({ artifactCount: 3 })]);

    assert.equal(merged[0].workspaceArtifactCount, 3);
  });

  it("refreshes the artifact count on a session it already holds", () => {
    const current = [session({ workspaceArtifactCount: 1 })];

    const merged = mergeSessionSummaries(current, [summary({ artifactCount: 2, eventCount: 2 })]);

    assert.equal(merged[0].workspaceArtifactCount, 2);
  });

  it("does not roll the artifact count back when a summary predates SSE", () => {
    const output = {
      id: "evt_output",
      type: "agent.output" as const,
      sessionId: "ses_1",
      timestamp: "2026-06-20T00:00:03.000Z",
      runId: "run_1",
      agent: "pi" as const,
      stream: "stdout" as const,
      text: "newer",
      sequence: 0,
    };
    const current = [session({ events: [output], workspaceArtifactCount: 3 })];

    const merged = mergeSessionSummaries(current, [summary({ artifactCount: 0, eventCount: 0 })]);

    assert.equal(merged[0].workspaceArtifactCount, 3);
  });

  it("keeps SSE events that arrived after a detail request began", () => {
    const output = {
      id: "evt_output",
      type: "agent.output" as const,
      sessionId: "ses_1",
      timestamp: "2026-06-20T00:00:02.000Z",
      runId: "run_1",
      agent: "pi" as const,
      stream: "stdout" as const,
      text: "hello",
      sequence: 0,
    };
    const current = [session({ events: [output] })];
    const staleSnapshot = session({ updatedAt: "2026-06-20T00:00:01.000Z" });

    const merged = mergeSessionSnapshotIntoSessions(current, staleSnapshot);

    assert.deepEqual(merged[0].events.map((event) => event.id), ["evt_output"]);
  });
});

describe("thread list pages", () => {
  const at = (second: number) => `2026-06-20T00:00:${String(second).padStart(2, "0")}.000Z`;

  it("keeps older loaded pages below a polled first page", () => {
    const loaded = [session({ id: "new", updatedAt: at(9) }), session({ id: "old", updatedAt: at(1) })];
    const merged = mergeSessionHeadPage(loaded, [summary({ id: "new", updatedAt: at(9) })], true);
    assert.deepEqual(merged.map((item) => item.id), ["new", "old"]);
  });

  it("drops a session the page's range no longer lists", () => {
    const loaded = [session({ id: "gone", updatedAt: at(8) }), session({ id: "old", updatedAt: at(1) })];
    const merged = mergeSessionHeadPage(loaded, [summary({ id: "top", updatedAt: at(9) }), summary({ id: "edge", updatedAt: at(5) })], true);
    assert.deepEqual(merged.map((item) => item.id), ["top", "edge", "old"]);
  });

  it("treats a page with nothing older as the whole list", () => {
    const loaded = [session({ id: "old", updatedAt: at(1) })];
    const merged = mergeSessionHeadPage(loaded, [summary({ id: "top", updatedAt: at(9) })], false);
    assert.deepEqual(merged.map((item) => item.id), ["top"]);
  });

  it("moves a thread that became active to the top without a duplicate", () => {
    const loaded = [session({ id: "a", updatedAt: at(9) }), session({ id: "b", updatedAt: at(1) })];
    const merged = mergeSessionHeadPage(loaded, [summary({ id: "b", updatedAt: at(10) }), summary({ id: "a", updatedAt: at(9) })], true);
    assert.deepEqual(merged.map((item) => item.id), ["b", "a"]);
  });

  it("appends only sessions not already loaded and keeps the cached record", () => {
    const cached = session({ id: "a", title: "cached", events: [{ id: "e" }] as unknown as RelaySession["events"] });
    const current = [cached];
    const appended = appendOlderSessionPage(current, [summary({ id: "a", title: "stale" }), summary({ id: "b" })]);
    assert.deepEqual(appended.map((item) => item.id), ["a", "b"]);
    assert.equal(appended[0], cached);
    assert.equal(appendOlderSessionPage(current, [summary({ id: "a" })]), current);
  });
});
