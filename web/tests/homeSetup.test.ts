import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { homeSetup } from "../src/lib/homeSetup.js";
import type { DaemonNodeMonitorRecord, UserAgent } from "../src/types.js";

const ME = "alice";

function node(input: Partial<DaemonNodeMonitorRecord> & { id: string }): DaemonNodeMonitorRecord {
  return {
    userId: ME,
    workspaceId: input.id,
    computerId: `device:${ME}:${input.id}`,
    displayName: input.id,
    online: true,
    stale: false,
    activeRuns: [],
    agents: {},
    ...input,
  } as DaemonNodeMonitorRecord;
}

function agent(input: Partial<UserAgent> & { id: string }): UserAgent {
  return { displayName: input.id, enabled: true, deletedAt: null, availability: "ready", ...input } as UserAgent;
}

describe("homeSetup", () => {
  it("counts my computers once each and names the dark ones", () => {
    const nodes = [
      node({ id: "mac" }),
      // An older record of the same machine: one computer, online through the live record.
      node({ id: "mac-old", workspaceId: "mac", online: false }),
      node({ id: "linux", displayName: "studio-linux", online: false }),
      node({ id: "stale", displayName: "pi", stale: true }),
      node({ id: "gone", online: false, retiredAt: "2026-10-01T00:00:00.000Z" }),
      node({ id: "bobs", userId: "bob", online: false }),
    ];

    const { computers } = homeSetup(nodes, [], ME);

    assert.deepEqual(computers, { total: 3, online: 1, offline: ["pi", "studio-linux"] });
  });

  it("counts active agents and names the ones that cannot take work", () => {
    const agents = [
      agent({ id: "a", availability: "ready" }),
      agent({ id: "b", availability: "busy" }),
      agent({ id: "c", displayName: "Codex", availability: "offline" }),
      agent({ id: "d", enabled: false, availability: "offline" }),
      agent({ id: "e", deletedAt: "2026-10-01T00:00:00.000Z" }),
    ];

    const { agents: summary } = homeSetup([], agents, ME);

    assert.deepEqual(summary, { total: 3, ready: 2, unavailable: ["Codex"] });
  });
});
