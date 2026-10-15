import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, it } from "node:test";

import {
  disabledSetsEqual,
  newlyDisabledReadyAgents,
  normalizeDisabledAgentsPayload,
  shouldSnapshotDisabledAgents,
} from "../src/lib/manageExecutors.js";
import type { AgentName } from "../src/types.js";

describe("shouldSnapshotDisabledAgents", () => {
  it("snapshots when the drawer first opens with a node", () => {
    assert.equal(shouldSnapshotDisabledAgents(true, null, "sbx_alice"), true);
  });

  it("does NOT re-snapshot while open with the same node (poll race guard)", () => {
    assert.equal(shouldSnapshotDisabledAgents(true, "sbx_alice", "sbx_alice"), false);
  });

  it("re-snapshots when the targeted node changes", () => {
    assert.equal(shouldSnapshotDisabledAgents(true, "sbx_alice", "sbx_bob"), true);
  });

  it("does not snapshot when closed", () => {
    assert.equal(shouldSnapshotDisabledAgents(false, null, "sbx_alice"), false);
  });

  it("does not snapshot when there is no current node", () => {
    assert.equal(shouldSnapshotDisabledAgents(true, null, null), false);
  });
});

describe("normalizeDisabledAgentsPayload", () => {
  it("sorts and dedupes", () => {
    const input: AgentName[] = ["codex", "pi", "codex", "claude"];
    assert.deepEqual(normalizeDisabledAgentsPayload(input), ["claude", "codex", "pi"]);
  });

  it("accepts a Set", () => {
    const input = new Set<AgentName>(["pi", "claude"]);
    assert.deepEqual(normalizeDisabledAgentsPayload(input), ["claude", "pi"]);
  });

  it("returns an empty array for an empty input", () => {
    assert.deepEqual(normalizeDisabledAgentsPayload([]), []);
  });
});

describe("newlyDisabledReadyAgents", () => {
  it("flags ready agents being disabled for the first time", () => {
    const initial = new Set<AgentName>([]);
    const next = new Set<AgentName>(["codex", "claude"]);
    const statuses = { codex: "ready", claude: "failed", pi: "ready" } as const;
    assert.deepEqual(newlyDisabledReadyAgents(initial, next, statuses), ["codex"]);
  });

  it("ignores agents that were already disabled", () => {
    const initial = new Set<AgentName>(["codex"]);
    const next = new Set<AgentName>(["codex", "pi"]);
    const statuses = { codex: "ready", pi: "ready" } as const;
    assert.deepEqual(newlyDisabledReadyAgents(initial, next, statuses), ["pi"]);
  });

  it("returns empty when no newly-disabled agent is ready", () => {
    const initial = new Set<AgentName>([]);
    const next = new Set<AgentName>(["codex"]);
    const statuses = { codex: "failed" } as const;
    assert.deepEqual(newlyDisabledReadyAgents(initial, next, statuses), []);
  });
});

describe("disabledSetsEqual", () => {
  it("returns true for equal sets regardless of insertion order", () => {
    const a = new Set<AgentName>(["claude", "codex"]);
    const b = new Set<AgentName>(["codex", "claude"]);
    assert.equal(disabledSetsEqual(a, b), true);
  });

  it("returns false when sizes differ", () => {
    assert.equal(disabledSetsEqual(new Set(["claude"]), new Set(["claude", "pi"])), false);
  });

  it("returns false when contents differ", () => {
    assert.equal(disabledSetsEqual(new Set(["claude"]), new Set(["pi"])), false);
  });
});

describe("user placement details", () => {
  it("shows sandbox implementation only to administrators", async () => {
    const source = await readFile(
      resolve("web/src/components/PlacementList.tsx"),
      "utf8",
    );

    assert.match(source, /showSandbox=\{canManage\}/);
    assert.doesNotMatch(source, /\n\s+showSandbox\n/);
  });
});
