import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  agentsOnNodes,
  buildEmployeeSummaries,
  employeeEmptyStateTranslationKey,
  employeesByStatus,
  employeeSummaryStatus,
  formatRelativeTime,
  EMPLOYEE_SUMMARY_STATUS_ORDER,
  nodesByStatus,
  NODE_STATUS_ORDER,
  initialsOf,
  isStale,
  matchesEmployeeQuickFilter,
  matchesNodeQuickFilter,
  nodeAgentPresence,
  stableNodeOrder,
  statusTone,
  truncateId,
  visualStatus,
} from "../src/lib/adminHelpers.js";
import type { AgentPlacement, ControlPanelDaemonNodeRecord, EmployeeAgent, EmployeeRecord } from "../src/types.js";

function node(input: Partial<ControlPanelDaemonNodeRecord> & { id: string }): ControlPanelDaemonNodeRecord {
  return {
    id: input.id,
    displayName: input.displayName,
    employeeId: input.employeeId,
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

function employee(input: Partial<EmployeeRecord> & { id: string }): EmployeeRecord {
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

  it("treats nodes seen >15s ago as stale", () => {
    const n = node({ id: "a", lastSeenAt: new Date(Date.now() - 20_000).toISOString() });
    assert.equal(isStale(n), true);
  });

  it("treats fresh online nodes as not stale", () => {
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
      lastSeenAt: new Date(Date.now() - 20_000).toISOString(),
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

describe("statusTone", () => {
  it("maps known statuses to tones", () => {
    assert.equal(statusTone("ready"), "good");
    assert.equal(statusTone("running"), "info");
    assert.equal(statusTone("busy"), "info");
    assert.equal(statusTone("provisioning"), "info");
    assert.equal(statusTone("failed"), "bad");
    assert.equal(statusTone("stale"), "bad");
    assert.equal(statusTone("pending"), "warn");
    assert.equal(statusTone("stopped"), "warn");
    assert.equal(statusTone("anything-else"), "neutral");
  });
});

describe("truncateId", () => {
  it("returns short ids verbatim", () => {
    assert.equal(truncateId("short"), "short");
  });
  it("truncates long ids with an ellipsis", () => {
    assert.equal(truncateId("sandbox-abcdef-1234", 4, 4), "sand…1234");
  });
});

describe("buildEmployeeSummaries", () => {
  it("aggregates nodes by employee and counts ready/running", () => {
    const employees = [employee({ id: "alice", displayName: "Alice" }), employee({ id: "bob" })];
    const nodes = [
      node({ id: "n1", employeeId: "alice", status: "ready" }),
      node({ id: "n2", employeeId: "alice", status: "running" }),
      node({ id: "n3", employeeId: "bob", status: "ready" }),
      node({ id: "orphan", employeeId: undefined }),
    ];
    const summaries = buildEmployeeSummaries(employees, nodes);
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
      node({ id: "n1", employeeId: "alice", status: "failed" }),
      node({ id: "n2", employeeId: "alice", status: "ready", stale: true }),
      node({ id: "n3", employeeId: "alice", status: "stopped" }),
    ];
    const summaries = buildEmployeeSummaries([employee({ id: "alice" })], nodes);
    const alice = summaries.find((s) => s.id === "alice");
    assert.ok(alice, "alice summary missing");
    // failed + stale count; the stopped node is neither active nor failed.
    assert.equal(alice.failedCount, 2);
    assert.equal(alice.readyCount, 0);
    assert.equal(alice.runningCount, 0);
    assert.equal(matchesEmployeeQuickFilter(alice, "failed"), true);
    assert.deepEqual(employeeSummaryStatus(alice), { tone: "bad", key: "failed" });
  });

  it("includes employees that have no nodes", () => {
    const summaries = buildEmployeeSummaries([employee({ id: "ghost" })], []);
    assert.equal(summaries.length, 1);
    assert.equal(summaries[0].nodeCount, 0);
  });

  it("surfaces phantom employee-ids that appear only on nodes", () => {
    const summaries = buildEmployeeSummaries([], [node({ id: "n1", employeeId: "phantom" })]);
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

    const [employeeSummary] = buildEmployeeSummaries(
      [employee({ id: "alice" })],
      [{ ...staleStopped, employeeId: "alice" }],
    );
    assert.equal(employeeSummary.failedCount, 1);
    assert.equal(matchesEmployeeQuickFilter(employeeSummary, "failed"), true);
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

  it("uses filter-oriented employee empty copy when there is no search query", () => {
    assert.equal(
      employeeEmptyStateTranslationKey("", "failed"),
      "admin.v2.no_employees_for_filter",
    );
    assert.equal(
      employeeEmptyStateTranslationKey("alice", "failed"),
      "admin.v2.no_match",
    );
  });
});

function placement(input: Partial<AgentPlacement> & Pick<AgentPlacement, "id" | "daemonNodeId">): AgentPlacement {
  return {
    agentId: "agent",
    employeeId: "someone",
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

function agent(input: Partial<EmployeeAgent> & Pick<EmployeeAgent, "id">): EmployeeAgent {
  return {
    supervisorEmployeeId: "someone",
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
  const alice = buildEmployeeSummaries(
    [employee({ id: "alice" })],
    [node({ id: "n1", employeeId: "alice" }), node({ id: "n2", employeeId: "alice" })],
  )[0];
  const agentsForEmployee = (member: typeof alice, agents: EmployeeAgent[]) =>
    agentsOnNodes(member.nodes.map((n) => n.id), agents);

  it("resolves agents through the employee's nodes, not the agent's supervisor", () => {
    const agents = [
      // Placed on one of alice's nodes → hers, even though the supervisor points elsewhere.
      agent({ id: "on-node", supervisorEmployeeId: "bob", placements: [placement({ id: "p1", daemonNodeId: "n2" })] }),
      // Supervised by alice but placed on a foreign node → not shown.
      agent({ id: "elsewhere", supervisorEmployeeId: "alice", placements: [placement({ id: "p2", daemonNodeId: "other" })] }),
      // No placements at all → not shown.
      agent({ id: "unplaced", supervisorEmployeeId: "alice", placements: [] }),
    ];
    assert.deepEqual(agentsForEmployee(alice, agents).map((a) => a.id), ["on-node"]);
  });

  it("ignores removed placements and deleted agents", () => {
    const agents = [
      agent({ id: "removed-placement", placements: [placement({ id: "p1", daemonNodeId: "n1", desiredState: "removed" })] }),
      agent({ id: "deleted", deletedAt: "2026-01-01", placements: [placement({ id: "p2", daemonNodeId: "n1" })] }),
      agent({ id: "live", placements: [placement({ id: "p3", daemonNodeId: "n1" })] }),
    ];
    assert.deepEqual(agentsForEmployee(alice, agents).map((a) => a.id), ["live"]);
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

    assert.deepEqual(agentsForEmployee(alice, agents).map((a) => a.id), ["replaced-runtime"]);
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

describe("employeesByStatus", () => {
  it("bands every employee under the state their own row derives", () => {
    const employees = [
      employee({ id: "a", displayName: "A" }),
      employee({ id: "b", displayName: "B" }),
      employee({ id: "c", displayName: "C" }),
      employee({ id: "d", displayName: "D" }),
    ];
    const nodes = [
      node({ id: "n1", employeeId: "a", status: "running", activeRuns: [{ id: "r" }] as never }),
      node({ id: "n2", employeeId: "b", status: "ready" }),
      node({ id: "n3", employeeId: "c", status: "failed" }),
    ];
    const summaries = buildEmployeeSummaries(employees, nodes);

    const grouped = employeesByStatus(summaries);
    const total = EMPLOYEE_SUMMARY_STATUS_ORDER.reduce((sum, key) => sum + grouped[key].length, 0);

    // A partition: every employee lands in exactly one band.
    assert.equal(total, summaries.length);
    for (const summary of summaries) {
      const { key } = employeeSummaryStatus(summary);
      assert.ok(grouped[key].some((member) => member.id === summary.id));
    }
    // The employee with no computer at all is the one band nothing else fills.
    assert.deepEqual(grouped.no_nodes.map((member) => member.id), ["d"]);
  });

  it("keeps a band for every declared state, even an empty one", () => {
    const grouped = employeesByStatus(buildEmployeeSummaries([], []));
    for (const key of EMPLOYEE_SUMMARY_STATUS_ORDER) assert.deepEqual(grouped[key], []);
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
    assert.equal(formatRelativeTime(ago(5 * HOUR), t), "5 hours ago");
  });

  // An agent created three months ago read "Created 2160 hours ago": the
  // formatter had no unit above the hour.
  it("rolls up to days, weeks, months and years", () => {
    assert.equal(formatRelativeTime(ago(3 * DAY), t), "3 days ago");
    assert.equal(formatRelativeTime(ago(14 * DAY), t), "2 weeks ago");
    assert.equal(formatRelativeTime(ago(90 * DAY), t), "3 months ago");
    assert.equal(formatRelativeTime(ago(800 * DAY), t), "2 years ago");
  });
});
