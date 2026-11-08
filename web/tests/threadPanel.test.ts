import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { threadPanelLayout } from "../src/lib/threadPanel.js";
import type { RelaySession } from "../src/types.js";

function session(partial: Partial<RelaySession> & { summaryEventCount?: number } = {}): RelaySession {
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

const idle = { threadsLoading: false, activeSession: undefined, hasPendingMessage: false, hasOnboardingPanel: false };

describe("threadPanelLayout", () => {
  it("draws the new-thread landing once the list says there is no thread", () => {
    assert.deepEqual(threadPanelLayout(idle), { landing: true, transcriptPending: false });
  });

  it("keeps the docked shape and an empty transcript while the thread list loads", () => {
    assert.deepEqual(threadPanelLayout({ ...idle, threadsLoading: true }), { landing: false, transcriptPending: true });
  });

  it("holds the transcript while the thread is only its list summary", () => {
    const layout = threadPanelLayout({ ...idle, activeSession: session({ summaryEventCount: 4 }) });
    assert.deepEqual(layout, { landing: false, transcriptPending: true });
  });

  it("draws the transcript once the detail has brought the thread's events", () => {
    const events = [{ type: "session.created" }] as unknown as RelaySession["events"];
    const layout = threadPanelLayout({ ...idle, activeSession: session({ summaryEventCount: 1, events }) });
    assert.equal(layout.transcriptPending, false);
  });

  it("draws a thread with no events that the summary does not claim more for", () => {
    assert.equal(threadPanelLayout({ ...idle, activeSession: session() }).transcriptPending, false);
  });

  it("always draws a message the person just sent", () => {
    const layout = threadPanelLayout({ ...idle, threadsLoading: true, hasPendingMessage: true });
    assert.deepEqual(layout, { landing: false, transcriptPending: false });
  });

  it("gives an onboarding panel the page instead of the landing", () => {
    assert.equal(threadPanelLayout({ ...idle, hasOnboardingPanel: true }).landing, false);
  });
});
