import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  isPersonalComputer,
  agentsOnNodes,
  buildUserSummaries,
  userEmptyStateTranslationKey,
  usersByStatus,
  userSummaryStatus,
  formatRelativeTime,
  USER_SUMMARY_STATUS_ORDER,
  nodesByStatus,
  NODE_STATUS_ORDER,
  initialsOf,
  isStale,
  matchesUserQuickFilter,
  matchesNodeQuickFilter,
  nodeAgentPresence,
  stableNodeOrder,
  statusTone,
  agentAvailabilityTone,
  agentStatusTone,
  runtimeStatusLabel,
  visibleNodeAgentNames,
  truncateId,
  visualStatus,
} from "../src/lib/adminHelpers.js";
import type { AgentPlacement, ControlPanelDaemonNodeRecord, UserAgent, UserRecord } from "../src/types.js";

function node(input: Partial<ControlPanelDaemonNodeRecord> & { id: string }): ControlPanelDaemonNodeRecord {
  return {
    id: input.id,
    displayName: input.displayName,
    userId: input.userId,
    status: input.status ?? "ready",
    online: input.online ?? true,
    stale: input.stale,
    lastSeenAt: input.lastSeenAt ?? new Date().toISOString(),
    lastSeenAgeMs: input.lastSeenAgeMs,
    lastError: input.lastError,
    workspacePath: input.workspacePath,
    nodeToken: input.nodeToken,
    queuedCommandCount: input.queuedCommandCount ?? 0,
    activeRuns: input.activeRuns ?? [],
    agents: input.agents ?? { claude: "ready", pi: "ready", codex: "ready", kimi: "ready" },
    disabledAgents: input.disabledAgents,
  } as ControlPanelDaemonNodeRecord;
}

describe("stableNodeOrder", () => {
  it("keeps card order stable when polling returns the same nodes in a different order", () => {
    const alpha = node({ id: "node-z", displayName: "Alpha" });
    const zebra = node({ id: "node-a", displayName: "Zebra" });

    const firstPoll = stableNodeOrder([zebra, alpha]).map((item) => item.id);
    const secondPoll = stableNodeOrder([alpha, zebra]).map((item) => item.id);

    assert.deepEqual(firstPoll, ["node-z", "node-a"]);
    assert.deepEqual(secondPoll, firstPoll);
  });
});

function user(input: Partial<UserRecord> & { id: string }): UserRecord {
  return {
    id: input.id,
    displayName: input.displayName ?? input.id,
    email: input.email,
    departmentId: input.departmentId,
    departmentName: input.departmentName,
  };
}

describe("isStale + visualStatus", () => {
  it("treats explicit stale flag as authoritative", () => {
    const n = node({ id: "a", stale: true, status: "ready", online: true });
    assert.equal(isStale(n), true);
    assert.equal(visualStatus(n), "stale");
  });

  it("treats offline nodes as stale", () => {
    const n = node({ id: "a", online: false });
    assert.equal(isStale(n), true);
  });

  it("never judges staleness by its own clock when the backend sent no flag", () => {
    const n = node({ id: "a", online: true, lastSeenAt: new Date(Date.now() - 20_000).toISOString() });
    assert.equal(isStale(n), false);
  });

  it("treats online nodes as not stale", () => {
    const n = node({ id: "a", lastSeenAt: new Date().toISOString() });
    assert.equal(isStale(n), false);
    assert.equal(visualStatus(n), "ready");
  });
});

describe("nodeAgentPresence", () => {
  it("is online only when the computer is live and the executor reported ready", () => {
    const live = node({ id: "a", agents: { claude: "ready", codex: "unknown", pi: "failed", kimi: "ready" } });
    assert.equal(nodeAgentPresence(live, "claude"), "online");
    assert.equal(nodeAgentPresence(live, "codex"), "offline");
    assert.equal(nodeAgentPresence(live, "pi"), "offline");
  });

  it("takes every agent offline when the computer is dark, whatever it last reported", () => {
    const dark = node({ id: "a", online: false, agents: { claude: "ready", codex: "ready", pi: "ready", kimi: "ready" } });
    assert.equal(nodeAgentPresence(dark, "claude"), "offline");

    const stale = node({
      id: "b",
      stale: true,
      agents: { claude: "ready", codex: "ready", pi: "ready", kimi: "ready" },
    });
    assert.equal(nodeAgentPresence(stale, "claude"), "offline");
  });

  it("reports a disabled executor as disabled rather than offline", () => {
    const live = node({ id: "a", disabledAgents: ["codex"] });
    assert.equal(nodeAgentPresence(live, "codex"), "disabled");

    // Disabled outranks liveness so the operator's own choice stays legible
    // on a machine that happens to be off.
    const dark = node({ id: "b", online: false, disabledAgents: ["codex"] });
    assert.equal(nodeAgentPresence(dark, "codex"), "disabled");
  });
});

describe("runtime status", () => {
  const t = ((key: string) => key) as never;

  it("tells a runtime that can't connect from one that is not installed or not responding", () => {
    assert.equal(runtimeStatusLabel("ready", t), "status.ready");
    assert.equal(runtimeStatusLabel("failed", t), "computer.runtime_failed");
    assert.equal(runtimeStatusLabel("unavailable", t), "computer.runtime_unavailable");
    assert.equal(runtimeStatusLabel("unresponsive", t), "computer.runtime_unresponsive");
    assert.equal(runtimeStatusLabel("unknown", t), "computer.runtime_no_signal");
  });

  it("is loud only for a broken runtime; not installed is a fact, not a fault", () => {
    assert.equal(agentStatusTone("ready"), "good");
    assert.equal(agentStatusTone("failed"), "bad");
    assert.equal(agentStatusTone("unresponsive"), "warn");
    assert.equal(agentStatusTone("unavailable"), "neutral");
    assert.equal(agentStatusTone("unknown"), "neutral");
    assert.equal(agentStatusTone("failed", { disabled: true }), "neutral");
  });

  it("lists opt-in Pi only once the computer reports it installed", () => {
    const listed = (pi: ControlPanelDaemonNodeRecord["agents"]["pi"]) =>
      visibleNodeAgentNames(node({ id: "a", agents: { claude: "ready", codex: "ready", kimi: "ready", pi } })).includes("pi");
    assert.equal(listed("unknown"), false);
    assert.equal(listed("unavailable"), false);
    assert.equal(listed("failed"), true);
    assert.equal(listed("unresponsive"), true);
    assert.equal(listed("ready"), true);
  });
});

describe("statusTone", () => {
  it("maps known statuses to tones", () => {
    assert.equal(statusTone("ready"), "good");
    assert.equal(statusTone("running"), "info");
    assert.equal(statusTone("busy"), "info");
    assert.equal(statusTone("provisioning"), "info");
    assert.equal(statusTone("failed"), "bad");
    assert.equal(statusTone("pending"), "warn");
    assert.equal(statusTone("stopped"), "warn");
    assert.equal(statusTone("anything-else"), "neutral");
  });
  it("keeps the critical tone for failure and spends nothing on absence", () => {
    // A computer that has not checked in lately is degraded, not broken, and
    // takes the same gold the control panel's fleet readout already draws it
    // with; a computer that is simply not connected is a resting state. Red is
    // reserved for something that actually went wrong.
    assert.equal(statusTone("stale"), "warn");
    assert.equal(statusTone("offline"), "neutral");
    assert.equal(statusTone("failed"), "bad");
  });
});

describe("agentAvailabilityTone", () => {
  it("does not paint an unconnected agent as a failure", () => {
    // Most of a roster is offline most of the time. Spending --err there makes
    // an idle workforce read as an incident and leaves nothing louder for an
    // agent that actually broke.
    assert.equal(agentAvailabilityTone("offline"), "neutral");
    assert.equal(agentAvailabilityTone("ready"), "good");
    assert.equal(agentAvailabilityTone("busy"), "info");
    assert.equal(agentAvailabilityTone("pending"), "warn");
  });
});

describe("truncateId", () => {
  it("returns short ids verbatim", () => {
    assert.equal(truncateId("short"), "short");
  });
  it("leaves a readable named id whole rather than eliding four characters", () => {
    // The regression this guards: `agent-builder` rendered as `agen…lder` in
    // a record band wide enough for the whole thing.
    assert.equal(truncateId("agent-builder"), "agent-builder");
    assert.equal(truncateId("sandbox-abcdef-1234"), "sandbox-abcdef-1234");
  });
  it("truncates a generated id with an ellipsis", () => {
    assert.equal(truncateId("task_m1k2j3h4_a1b2c3"), "task_m1k2j3h4_a1b2c3");
    assert.equal(truncateId("task_m1k2j3h4g5f6_a1b2c3d4e5"), "task_m1k…b2c3d4e5");
  });
  it("honours an explicit head/tail once the id is long enough to elide", () => {
    assert.equal(truncateId("task_m1k2j3h4g5f6_a1b2c3d4e5", 4, 4), "task…d4e5");
  });
});

describe("buildUserSummaries", () => {
  it("aggregates nodes by user and counts ready/running", () => {
    const users = [user({ id: "alice", displayName: "Alice" }), user({ id: "bob" })];
    const nodes = [
      node({ id: "n1", userId: "alice", status: "ready" }),
      node({ id: "n2", userId: "alice", status: "running" }),
      node({ id: "n3", userId: "bob", status: "ready" }),
      node({ id: "orphan", userId: undefined }),
    ];
    const summaries = buildUserSummaries(users, nodes);
    const alice = summaries.find((s) => s.id === "alice");
    const bob = summaries.find((s) => s.id === "bob");
    assert.ok(alice, "alice summary missing");
    assert.equal(alice.nodeCount, 2);
    assert.equal(alice.readyCount, 1);
    assert.equal(alice.runningCount, 1);
    assert.equal(alice.failedCount, 0);
    assert.ok(bob);
    assert.equal(bob.nodeCount, 1);
  });

  it("counts failed and stale nodes so they don't hide as idle", () => {
    const nodes = [
      node({ id: "n1", userId: "alice", status: "failed" }),
      node({ id: "n2", userId: "alice", status: "ready", stale: true }),
      node({ id: "n3", userId: "alice", status: "stopped" }),
    ];
    const summaries = buildUserSummaries([user({ id: "alice" })], nodes);
    const alice = summaries.find((s) => s.id === "alice");
    assert.ok(alice, "alice summary missing");
    // failed + stale count; the stopped node is neither active nor failed.
    assert.equal(alice.failedCount, 2);
    assert.equal(alice.readyCount, 0);
    assert.equal(alice.runningCount, 0);
    assert.equal(matchesUserQuickFilter(alice, "failed"), true);
    assert.deepEqual(userSummaryStatus(alice), { tone: "bad", key: "failed" });
  });

  it("reads a fleet whose only problem is a quiet computer as degraded, not failed", () => {
    // Same "Failed / stale" bucket for filtering and sorting, but the tone
    // follows the worst machine in it: a lapsed heartbeat is gold everywhere
    // else in the app, so it must not turn the user's card red.
    const nodes = [node({ id: "n1", userId: "bob", stale: true, status: "ready" })];
    const bob = buildUserSummaries([user({ id: "bob" })], nodes).find((s) => s.id === "bob");
    assert.ok(bob, "bob summary missing");
    assert.equal(bob.failedCount, 1);
    assert.deepEqual(userSummaryStatus(bob), { tone: "warn", key: "failed" });
  });

  it("includes users that have no nodes", () => {
    const summaries = buildUserSummaries([user({ id: "ghost" })], []);
    assert.equal(summaries.length, 1);
    assert.equal(summaries[0].nodeCount, 0);
  });

  it("surfaces phantom user-ids that appear only on nodes", () => {
    const summaries = buildUserSummaries([], [node({ id: "n1", userId: "phantom" })]);
    const phantom = summaries.find((s) => s.id === "phantom");
    assert.ok(phantom, "phantom missing");
    assert.equal(phantom.displayName, "phantom");
    assert.equal(phantom.nodeCount, 1);
  });
});

describe("admin quick filters", () => {
  it("includes healthy idle computers in the running slice", () => {
    const ready = node({ id: "ready", status: "ready", online: true, stale: false });
    const busy = node({ id: "busy", status: "busy", online: true, stale: false });

    assert.equal(matchesNodeQuickFilter(ready, "ready"), true);
    assert.equal(matchesNodeQuickFilter(ready, "running"), true);
    assert.equal(matchesNodeQuickFilter(busy, "running"), true);
  });

  it("keeps a stale stopped record in the failed slice", () => {
    const staleStopped = node({ id: "stale-stopped", status: "stopped", online: false, stale: true });

    assert.equal(visualStatus(staleStopped), "stale");
    assert.equal(matchesNodeQuickFilter(staleStopped, "stopped"), false);
    assert.equal(matchesNodeQuickFilter(staleStopped, "failed"), true);

    const [userSummary] = buildUserSummaries(
      [user({ id: "alice" })],
      [{ ...staleStopped, userId: "alice" }],
    );
    assert.equal(userSummary.failedCount, 1);
    assert.equal(matchesUserQuickFilter(userSummary, "failed"), true);
  });

  it("keeps an authoritative non-stale stopped placeholder in the stopped slice", () => {
    const stoppedPlaceholder = node({
      id: "stopped-placeholder",
      status: "stopped",
      online: false,
      stale: false,
      provisioningPlaceholder: true,
    });

    assert.equal(visualStatus(stoppedPlaceholder), "stopped");
    assert.equal(matchesNodeQuickFilter(stoppedPlaceholder, "stopped"), true);
    assert.equal(matchesNodeQuickFilter(stoppedPlaceholder, "failed"), false);
  });

  it("uses filter-oriented user empty copy when there is no search query", () => {
    assert.equal(
      userEmptyStateTranslationKey("", "failed"),
      "admin.v2.no_users_for_filter",
    );
    assert.equal(
      userEmptyStateTranslationKey("alice", "failed"),
      "admin.v2.no_match",
    );
  });
});

function placement(input: Partial<AgentPlacement> & Pick<AgentPlacement, "id" | "daemonNodeId">): AgentPlacement {
  return {
    agentId: "agent",
    userId: "someone",
    nodeDisplayName: undefined,
    executorKind: "claude",
    desiredState: "active",
    status: "ready",
    priority: 0,
    agentVersion: 1,
    workspacePolicy: {},
    conditions: [],
    createdAt: "",
    updatedAt: "",
    ...input,
  };
}

function agent(input: Partial<UserAgent> & Pick<UserAgent, "id">): UserAgent {
  return {
    supervisorUserId: "someone",
    displayName: input.id,
    executorKind: "claude",
    skillPolicy: {},
    toolPolicy: {},
    modelPolicy: {},
    enabled: true,
    version: 1,
    availability: "ready",
    placements: [],
    createdAt: "",
    updatedAt: "",
    ...input,
  };
}

describe("agentsOnNodes", () => {
  const alice = buildUserSummaries(
    [user({ id: "alice" })],
    [node({ id: "n1", userId: "alice" }), node({ id: "n2", userId: "alice" })],
  )[0];
  const agentsForUser = (member: typeof alice, agents: UserAgent[]) =>
    agentsOnNodes(member.nodes.map((n) => n.id), agents);

  it("resolves agents through the user's nodes, not the agent's supervisor", () => {
    const agents = [
      // Placed on one of alice's nodes → hers, even though the supervisor points elsewhere.
      agent({ id: "on-node", supervisorUserId: "bob", placements: [placement({ id: "p1", daemonNodeId: "n2" })] }),
      // Supervised by alice but placed on a foreign node → not shown.
      agent({ id: "elsewhere", supervisorUserId: "alice", placements: [placement({ id: "p2", daemonNodeId: "other" })] }),
      // No placements at all → not shown.
      agent({ id: "unplaced", supervisorUserId: "alice", placements: [] }),
    ];
    assert.deepEqual(agentsForUser(alice, agents).map((a) => a.id), ["on-node"]);
  });

  it("ignores removed placements and deleted agents", () => {
    const agents = [
      agent({ id: "removed-placement", placements: [placement({ id: "p1", daemonNodeId: "n1", desiredState: "removed" })] }),
      agent({ id: "deleted", deletedAt: "2026-01-01", placements: [placement({ id: "p2", daemonNodeId: "n1" })] }),
      agent({ id: "live", placements: [placement({ id: "p3", daemonNodeId: "n1" })] }),
    ];
    assert.deepEqual(agentsForUser(alice, agents).map((a) => a.id), ["live"]);
  });

  it("associates agents through the Computer's current runtime node", () => {
    const agents = [
      agent({
        id: "replaced-runtime",
        placements: [placement({
          id: "p1",
          daemonNodeId: "runtime-old",
          runtimeNodeId: "n1",
        })],
      }),
    ];

    assert.deepEqual(agentsForUser(alice, agents).map((a) => a.id), ["replaced-runtime"]);
  });
});

describe("initialsOf", () => {
  it("takes two letters from a single token", () => {
    assert.equal(initialsOf("alice"), "AL");
  });

  it("combines first and last parts", () => {
    assert.equal(initialsOf("alice.chen"), "AC");
    assert.equal(initialsOf("@bob-smith"), "BS");
  });

  it("falls back for empty input", () => {
    assert.equal(initialsOf(""), "?");
    assert.equal(initialsOf("   "), "?");
  });
});

describe("usersByStatus", () => {
  it("bands every user under the state their own row derives", () => {
    const users = [
      user({ id: "a", displayName: "A" }),
      user({ id: "b", displayName: "B" }),
      user({ id: "c", displayName: "C" }),
      user({ id: "d", displayName: "D" }),
    ];
    const nodes = [
      node({ id: "n1", userId: "a", status: "running", activeRuns: [{ id: "r" }] as never }),
      node({ id: "n2", userId: "b", status: "ready" }),
      node({ id: "n3", userId: "c", status: "failed" }),
    ];
    const summaries = buildUserSummaries(users, nodes);

    const grouped = usersByStatus(summaries);
    const total = USER_SUMMARY_STATUS_ORDER.reduce((sum, key) => sum + grouped[key].length, 0);

    // A partition: every user lands in exactly one band.
    assert.equal(total, summaries.length);
    for (const summary of summaries) {
      const { key } = userSummaryStatus(summary);
      assert.ok(grouped[key].some((member) => member.id === summary.id));
    }
    // The user with no computer at all is the one band nothing else fills.
    assert.deepEqual(grouped.no_nodes.map((member) => member.id), ["d"]);
  });

  it("keeps a band for every declared state, even an empty one", () => {
    const grouped = usersByStatus(buildUserSummaries([], []));
    for (const key of USER_SUMMARY_STATUS_ORDER) assert.deepEqual(grouped[key], []);
  });
});

describe("nodesByStatus", () => {
  it("orders known statuses by urgency and drops empty bands", () => {
    const grouped = nodesByStatus([
      node({ id: "n1", status: "ready" }),
      node({ id: "n2", status: "failed" }),
      node({ id: "n3", status: "ready" }),
    ]);

    assert.deepEqual(grouped.map((group) => group.status), ["failed", "ready"]);
    assert.deepEqual(grouped[1].nodes.map((n) => n.id), ["n1", "n3"]);
  });

  it("bands a status this build has never heard of rather than dropping it", () => {
    // `SandboxStatus` is closed in this build, so the cast is the point of
    // the test: it stands in for a backend one release ahead. A node the
    // list cannot classify still has to appear — it claims the whole fleet.
    const grouped = nodesByStatus([
      node({ id: "n1", status: "ready" }),
      node({ id: "n2", status: "quarantined" as ControlPanelDaemonNodeRecord["status"] }),
    ]);

    assert.deepEqual(grouped.map((group) => group.status), ["ready", "quarantined"]);
    for (const status of grouped.map((group) => group.status)) {
      assert.ok(NODE_STATUS_ORDER.includes(status) || status === "quarantined");
    }
  });
});

describe("formatRelativeTime", () => {
  const t = ((key: string) => key) as unknown as Parameters<typeof formatRelativeTime>[1];
  const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
  const HOUR = 3_600_000;
  const DAY = 24 * HOUR;

  it("keeps hours for anything under a day", () => {
    assert.equal(formatRelativeTime(ago(5 * HOUR), t), "5h ago");
  });

  // An agent created three months ago read "Created 2160 hours ago": the
  // formatter had no unit above the hour.
  it("rolls up to days, weeks, months and years", () => {
    assert.equal(formatRelativeTime(ago(3 * DAY), t), "3d ago");
    assert.equal(formatRelativeTime(ago(14 * DAY), t), "2w ago");
    assert.equal(formatRelativeTime(ago(90 * DAY), t), "3mo ago");
    assert.equal(formatRelativeTime(ago(800 * DAY), t), "2y ago");
  });

  // One relative-time voice: the rail's short form, in admin sentences too.
  it("speaks the thread rail's short form", () => {
    assert.equal(formatRelativeTime(ago(DAY + HOUR), t), "yesterday");
  });
});

describe("isPersonalComputer", () => {
  it("treats only an owned user-device computer as the user's own", () => {
    assert.equal(isPersonalComputer({ nodeLocation: "user-device", userId: "alice" }), true);
    assert.equal(isPersonalComputer({ nodeLocation: "user-device", userId: undefined }), false);
    assert.equal(isPersonalComputer({ nodeLocation: "managed", userId: "alice" }), false);
    assert.equal(isPersonalComputer({ nodeLocation: undefined, userId: "alice" }), false);
  });
});
