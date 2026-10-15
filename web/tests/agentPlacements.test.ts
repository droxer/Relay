import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, it } from "node:test";

import {
  describeAgentPlacements,
  placementBadgeDetailLabels,
  placementBadgeShowsSandbox,
} from "../src/lib/agentPlacements.js";
import type { AgentPlacement } from "../src/types.js";

function placement(input: Partial<AgentPlacement> & Pick<AgentPlacement, "id" | "daemonNodeId" | "priority">): AgentPlacement {
  return {
    id: input.id,
    agentId: input.agentId ?? "agent_alice",
    userId: input.userId ?? "alice",
    daemonNodeId: input.daemonNodeId,
    runtimeNodeId: input.runtimeNodeId,
    computerId: input.computerId,
    executorKind: input.executorKind ?? "codex",
    desiredState: input.desiredState ?? "active",
    status: input.status ?? "ready",
    priority: input.priority,
    agentVersion: input.agentVersion ?? 1,
    workspacePolicy: input.workspacePolicy ?? { kind: "user-home" },
    conditions: input.conditions ?? [],
    createdAt: input.createdAt ?? "2026-07-19T00:00:00Z",
    updatedAt: input.updatedAt ?? "2026-07-19T00:00:00Z",
    nodeDisplayName: input.nodeDisplayName,
    nodeOwnership: input.nodeOwnership,
    nodeSandboxMode: input.nodeSandboxMode,
  };
}

describe("describeAgentPlacements", () => {
  it("orders placements by routing priority and identifies managed versus local destinations", () => {
    const result = describeAgentPlacements([
      placement({
        id: "placement_local",
        daemonNodeId: "node_local",
        priority: 200,
        nodeDisplayName: "Alice’s MacBook",
        nodeOwnership: "user-device",
        nodeSandboxMode: "none",
      }),
      placement({
        id: "placement_managed",
        daemonNodeId: "node_managed",
        priority: 100,
        nodeDisplayName: "Managed node for Alice",
        nodeOwnership: "managed",
        nodeSandboxMode: "boxlite",
      }),
    ]);

    assert.deepEqual(result.map((item) => ({
      id: item.placement.id,
      preference: item.preference,
      ownership: item.ownership,
      sandbox: item.sandbox,
      name: item.nodeName,
    })), [
      {
        id: "placement_managed",
        preference: "preferred",
        ownership: "managed",
        sandbox: "boxlite",
        name: "Managed node for Alice",
      },
      {
        id: "placement_local",
        preference: "alternate",
        ownership: "local",
        sandbox: "host",
        name: "Alice’s MacBook",
      },
    ]);
  });

  it("never exposes direct-runtime implementation details in placement labels", () => {
    const labels = {
      nodeName: "Alice’s MacBook",
      ownership: "Local computer",
      sandboxLabel: "Direct on computer",
      status: "Ready",
    };

    assert.deepEqual(placementBadgeDetailLabels(labels, false), [
      "Alice’s MacBook",
      "Local computer",
      "Ready",
    ]);
    assert.deepEqual(placementBadgeDetailLabels(
      labels,
      placementBadgeShowsSandbox("host", true),
    ), [
      "Alice’s MacBook",
      "Local computer",
      "Ready",
    ]);
    assert.equal(placementBadgeShowsSandbox("host", true), false);
    assert.equal(placementBadgeShowsSandbox("boxlite", true), true);
    assert.equal(placementBadgeShowsSandbox("boxlite", false), false);
  });

  it("does not describe draining placements as preferred routes", () => {
    const result = describeAgentPlacements([
      placement({
        id: "placement_draining",
        daemonNodeId: "node_old",
        priority: 50,
        desiredState: "draining",
        status: "offline",
      }),
      placement({
        id: "placement_ready",
        daemonNodeId: "node_ready",
        priority: 100,
      }),
    ]);

    assert.deepEqual(result.map((item) => [item.placement.id, item.preference]), [
      ["placement_draining", null],
      ["placement_ready", "preferred"],
    ]);
  });

  it("dedupes placements pointing at the same computer, keeping the preferred route", () => {
    const result = describeAgentPlacements([
      placement({
        id: "placement_stale",
        daemonNodeId: "node_mac",
        priority: 200,
        status: "pending",
      }),
      placement({
        id: "placement_preferred",
        daemonNodeId: "node_mac",
        priority: 100,
      }),
      placement({
        id: "placement_other",
        daemonNodeId: "node_other",
        priority: 300,
      }),
    ]);

    assert.deepEqual(result.map((item) => [item.placement.id, item.preference]), [
      ["placement_preferred", "preferred"],
      ["placement_other", "alternate"],
    ]);
  });

  it("uses the current runtime while keeping the placement's original node for audit", () => {
    const [result] = describeAgentPlacements([
      placement({
        id: "placement_replaced_runtime",
        daemonNodeId: "runtime_old",
        runtimeNodeId: "runtime_new",
        computerId: "device:alice:machine-1",
        priority: 100,
      }),
    ]);

    assert.equal(result.nodeName, "runtime_new");
    assert.equal(result.placement.daemonNodeId, "runtime_old");
  });
});

describe("placement wording", () => {
  it("describes direct execution without process terminology", async () => {
    const translation = JSON.parse(await readFile(
      resolve("web/src/i18n/locales/en/translation.json"),
      "utf8",
    )) as { admin: { v2: Record<string, string> } };

    assert.equal(translation.admin.v2.node_sandbox_host, "Direct on computer");
    assert.equal(
      translation.admin.v2.profile_local_desc,
      "Agents run directly on this computer and reuse this user’s agent authentication.",
    );
    assert.equal(
      translation.admin.v2.node_help_local,
      "Agents run directly on this computer and reuse this user’s agent authentication.",
    );
  });
});
