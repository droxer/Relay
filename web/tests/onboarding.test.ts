import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { onboardingProgress, type OnboardingInputs } from "../src/lib/onboarding.js";
import type { DaemonNodeMonitorRecord, RelaySession, UserAgent } from "../src/types.js";

const USER = "user-1";

function node(overrides: Partial<DaemonNodeMonitorRecord> = {}): DaemonNodeMonitorRecord {
  return {
    id: "node-1",
    userId: USER,
    displayName: "MacBook Pro",
    nodeLocation: "user-device",
    online: true,
    stale: false,
    agents: { claude: "ready", codex: "unknown", pi: "unknown", kimi: "unknown" },
    disabledAgents: [],
    activeRuns: [],
    queuedCommandCount: 0,
    ...overrides,
  } as DaemonNodeMonitorRecord;
}

const READY_AGENT = {
  id: "agent-1", executorKind: "claude", availability: "ready", enabled: true,
  placements: [{ daemonNodeId: "node-1", desiredState: "active" }],
} as UserAgent;
const FINISHED_THREAD = { status: "completed", agentRuns: [{ status: "completed" }] } as unknown as RelaySession;

function inputs(overrides: Partial<OnboardingInputs> = {}): OnboardingInputs {
  return {
    user: { userId: USER, onboarding: { introSeenAt: "2026-10-16T00:00:00.000Z" } },
    nodes: [],
    agents: [],
    threads: [],
    ...overrides,
  };
}

describe("onboarding progress", () => {
  it("opens on the intro for a brand-new account", () => {
    const progress = onboardingProgress(inputs({ user: { userId: USER } }));
    assert.equal(progress.step, "intro");
    assert.equal(progress.visible, true);
    assert.equal(progress.completedCount, 0);
  });

  it("asks for a computer once the intro is read", () => {
    const progress = onboardingProgress(inputs());
    assert.equal(progress.step, "computer");
    assert.equal(progress.blocked, undefined);
  });

  it("does not count an offline or stale computer", () => {
    for (const offline of [node({ online: false }), node({ stale: true })]) {
      assert.equal(onboardingProgress(inputs({ nodes: [offline] })).done.computer, false);
    }
  });

  it("ignores computers that belong to someone else", () => {
    const progress = onboardingProgress(inputs({ nodes: [node({ userId: "someone-else" })] }));
    assert.equal(progress.done.computer, false);
  });

  it("holds the computer step while no runtime is ready", () => {
    const progress = onboardingProgress(inputs({
      nodes: [node({ agents: { claude: "failed", codex: "unknown", pi: "unknown", kimi: "ready", opencode: "unknown" }, disabledAgents: ["kimi"] })],
    }));
    assert.equal(progress.step, "computer");
    assert.equal(progress.blocked, "no_ready_runtime");
    assert.equal(progress.computer?.name, "MacBook Pro");
  });

  it("says when the account may not enroll a computer of its own", () => {
    const progress = onboardingProgress(inputs({
      user: { userId: USER, effectiveMaxLocalComputers: 0, onboarding: { introSeenAt: "x" } },
    }));
    assert.equal(progress.blocked, "computer_limit");
  });

  it("completes the computer step for an admin-assigned machine", () => {
    const progress = onboardingProgress(inputs({
      user: { userId: USER, effectiveMaxLocalComputers: 0, onboarding: { introSeenAt: "x" } },
      nodes: [node({ nodeLocation: "managed" } as Partial<DaemonNodeMonitorRecord>)],
    }));
    assert.equal(progress.done.computer, true);
    assert.equal(progress.step, "agent");
    assert.deepEqual(progress.computer?.readyRuntimes, ["claude"]);
  });

  it("needs an agent that can actually run", () => {
    const parked = [
      { ...READY_AGENT, availability: "offline" },
      { ...READY_AGENT, enabled: false },
      { ...READY_AGENT, deletedAt: "2026-10-16T00:00:00.000Z" },
    ] as UserAgent[];
    assert.equal(onboardingProgress(inputs({ nodes: [node()], agents: parked })).step, "agent");
    const busy = [{ ...READY_AGENT, availability: "busy" }] as UserAgent[];
    assert.equal(onboardingProgress(inputs({ nodes: [node()], agents: busy })).step, "thread");
  });

  it("finishes the thread step on a completed run", () => {
    const failed = { status: "failed", agentRuns: [] } as unknown as RelaySession;
    const base = { nodes: [node()], agents: [READY_AGENT] };
    assert.equal(onboardingProgress(inputs({ ...base, threads: [failed] })).step, "thread");
    const ranOnce = { status: "running", agentRuns: [{ status: "completed" }] } as unknown as RelaySession;
    assert.equal(onboardingProgress(inputs({ ...base, threads: [ranOnce] })).step, "explore");
    const progress = onboardingProgress(inputs({ ...base, threads: [FINISHED_THREAD] }));
    assert.equal(progress.step, "explore");
    assert.equal(progress.completedCount, 3);
  });

  it("does not count a manually completed thread whose runs all failed", () => {
    const progress = onboardingProgress(inputs({
      nodes: [node()], agents: [READY_AGENT],
      threads: [{ status: "completed", agentRuns: [{ status: "failed" }] } as RelaySession],
    }));
    assert.equal(progress.done.thread, false);
    assert.equal(progress.step, "thread");
  });

  it("pairs its ready agent with the computer hosting its active placement", () => {
    const progress = onboardingProgress(inputs({
      nodes: [node({ id: "other-computer" }), node()], agents: [READY_AGENT],
    }));
    assert.equal(progress.computer?.id, "node-1");
    assert.deepEqual(progress.agent, { id: "agent-1", executorKind: "claude" });
  });

  it("uses a placement's current runtime node rather than its original node", () => {
    const agent = { ...READY_AGENT, placements: [{ daemonNodeId: "retired-node", runtimeNodeId: "node-1", desiredState: "active" }] } as UserAgent;
    const progress = onboardingProgress(inputs({ nodes: [node()], agents: [agent] }));
    assert.equal(progress.agent?.id, "agent-1");
  });

  it("does not mark the agent ready without a usable placement and runtime", () => {
    for (const placements of [[], [{ daemonNodeId: "node-1", desiredState: "removed" }]]) {
      const agent = { ...READY_AGENT, placements } as UserAgent;
      assert.equal(onboardingProgress(inputs({ nodes: [node()], agents: [agent] })).done.agent, false);
    }
    const progress = onboardingProgress(inputs({
      nodes: [node({ disabledAgents: ["claude"] })], agents: [READY_AGENT],
    }));
    assert.equal(progress.done.agent, false);
  });

  it("hides once dismissed, or once every explore card is closed", () => {
    const done = { nodes: [node()], agents: [READY_AGENT], threads: [FINISHED_THREAD] };
    assert.equal(onboardingProgress(inputs({ user: { userId: USER, onboarding: { dismissedAt: "x" } } })).visible, false);
    const allClosed = onboardingProgress(inputs({
      ...done,
      user: { userId: USER, onboarding: { introSeenAt: "x", closedCards: ["tasks", "projects", "teams", "automations"] } },
    }));
    assert.deepEqual(allClosed.openCards, []);
    assert.equal(allClosed.visible, false);
    const someClosed = onboardingProgress(inputs({
      ...done,
      user: { userId: USER, onboarding: { introSeenAt: "x", closedCards: ["teams"] } },
    }));
    assert.deepEqual(someClosed.openCards, ["tasks", "projects", "automations"]);
    assert.equal(someClosed.visible, true);
  });

  it("stays out of the way of an account that set up before the wizard existed", () => {
    const progress = onboardingProgress(inputs({
      user: { userId: USER },
      nodes: [node()],
      agents: [READY_AGENT],
      threads: [FINISHED_THREAD],
    }));
    assert.equal(progress.visible, false);
  });
});
