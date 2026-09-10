import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildExecutorDisplayNameMap,
  buildLogicalAgentImageMap,
  displayNameForExecutor,
  imageForAgentRun,
  isEmployeeAgentRoutable,
  isLogicalAgentRoutable,
  labelForExecutor,
  preferredRoutableAgent,
  visualAvailabilityOf,
} from "../src/lib/agentDisplayNames.js";
import type { EmployeeAgent } from "../src/types.js";

function agent(
  input: Partial<EmployeeAgent> & Pick<EmployeeAgent, "id" | "displayName" | "executorKind">,
): EmployeeAgent {
  return {
    employeeId: "alice",
    skillPolicy: {},
    toolPolicy: {},
    modelPolicy: {},
    enabled: true,
    version: 1,
    availability: "ready",
    placements: [],
    createdAt: "2026-07-11T00:00:00.000Z",
    updatedAt: "2026-07-11T00:00:00.000Z",
    ...input,
  };
}

describe("agentDisplayNames", () => {
  it("prefers ready logical agents when multiple share an executor kind", () => {
    const logicalAgents = [
      agent({ id: "a1", displayName: "Offline Analyst", executorKind: "claude", availability: "offline" }),
      agent({ id: "a2", displayName: "Researcher", executorKind: "claude", availability: "ready" }),
      agent({ id: "a3", displayName: "Builder", executorKind: "codex" }),
    ];

    assert.equal(displayNameForExecutor("claude", logicalAgents), "Researcher");
    assert.deepEqual(buildExecutorDisplayNameMap(logicalAgents), {
      claude: "Researcher",
      codex: "Builder",
    });
  });

  it("treats busy agents as routable like the backend", () => {
    assert.equal(isLogicalAgentRoutable("ready"), true);
    assert.equal(isLogicalAgentRoutable("busy"), true);
    assert.equal(isLogicalAgentRoutable("pending"), false);
    assert.equal(isLogicalAgentRoutable("offline"), false);
  });

  it("does not select an inactive or offline agent for work", () => {
    const logicalAgents = [
      agent({ id: "offline", displayName: "Offline", executorKind: "claude", availability: "offline" }),
      agent({ id: "inactive", displayName: "Inactive", executorKind: "codex", enabled: false }),
    ];

    assert.equal(isEmployeeAgentRoutable(logicalAgents[0]), false);
    assert.equal(isEmployeeAgentRoutable(logicalAgents[1]), false);
    assert.equal(preferredRoutableAgent(logicalAgents, "offline"), undefined);
  });

  it("moves selection to a routable agent when the preferred agent goes offline", () => {
    const logicalAgents = [
      agent({ id: "offline", displayName: "Offline", executorKind: "claude", availability: "offline" }),
      agent({ id: "ready", displayName: "Ready", executorKind: "codex" }),
    ];

    assert.equal(preferredRoutableAgent(logicalAgents, "offline")?.id, "ready");
  });

  it("prefers ready over busy when resolving shared executor labels", () => {
    const logicalAgents = [
      agent({ id: "a1", displayName: "Busy Analyst", executorKind: "claude", availability: "busy" }),
      agent({ id: "a2", displayName: "Researcher", executorKind: "claude", availability: "ready" }),
    ];

    assert.equal(displayNameForExecutor("claude", logicalAgents), "Researcher");
  });

  it("falls back to capitalized executor labels when no logical agent exists", () => {
    assert.equal(displayNameForExecutor("kimi", []), "Kimi");
    assert.equal(labelForExecutor("pi", undefined), "Pi");
    assert.equal(labelForExecutor("pi", { pi: "Planner" }), "Planner");
  });

  it("resolves a turn's profile image by logical agent id, not executor kind", () => {
    // Two agents share an executor kind; only the one that ran the turn may
    // lend it a face. Agents with no upload stay out of the map — their
    // default profile image is the monogram, which needs no lookup.
    const logicalAgents = [
      agent({ id: "a1", displayName: "Researcher", executorKind: "claude", profileImageUrl: "/img/a1.png" }),
      agent({ id: "a2", displayName: "Reviewer", executorKind: "claude" }),
    ];
    const images = buildLogicalAgentImageMap(logicalAgents);

    assert.deepEqual(images, { a1: "/img/a1.png" });
    assert.equal(imageForAgentRun({ agentId: "a1" }, images), "/img/a1.png");
    assert.equal(imageForAgentRun({ agentId: "a2" }, images), undefined);
    // A legacy run carries no logical identity to resolve against.
    assert.equal(imageForAgentRun({}, images), undefined);
    assert.equal(imageForAgentRun({ agentId: "a1" }, undefined), undefined);
  });

  it("reports a disabled or deleted agent as inactive, not as its stale availability", () => {
    // An agent keeps whatever availability it had when it stopped, so showing
    // the raw value labels an unpickable agent "ready".
    assert.equal(visualAvailabilityOf(agent({ id: "a", displayName: "A", executorKind: "claude" })), "ready");
    assert.equal(
      visualAvailabilityOf(agent({ id: "a", displayName: "A", executorKind: "claude", enabled: false })),
      "inactive",
    );
    assert.equal(
      visualAvailabilityOf(agent({
        id: "a", displayName: "A", executorKind: "claude", deletedAt: "2026-01-01T00:00:00.000Z",
      })),
      "inactive",
    );
    // Busy is a live state, not an inactive one: it still routes.
    const busy = agent({ id: "a", displayName: "A", executorKind: "claude", availability: "busy" });
    assert.equal(visualAvailabilityOf(busy), "busy");
    assert.equal(isEmployeeAgentRoutable(busy), true);
    // Offline is reported as itself; inactivity is about the agent, not the placement.
    assert.equal(
      visualAvailabilityOf(agent({ id: "a", displayName: "A", executorKind: "claude", availability: "offline" })),
      "offline",
    );
  });
});
