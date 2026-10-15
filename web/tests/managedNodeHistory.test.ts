import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { managedNodeHistory } from "../src/lib/managedNodeHistory.js";
import type { ManagedNodeRecord } from "../src/types.js";

function managedNode(
  input: Pick<ManagedNodeRecord, "id" | "desiredState" | "phase" | "updatedAt">,
): ManagedNodeRecord {
  return {
    displayName: input.id,
    assignmentMode: "dedicated",
    provider: "local-process",
    profile: "standard",
    sandboxMode: "boxlite",
    workspacePolicy: { kind: "user-home" },
    generation: 1,
    conditions: [],
    createdAt: "2026-07-01T00:00:00Z",
    ...input,
  };
}

describe("managedNodeHistory", () => {
  it("returns only fully deleted records, newest first", () => {
    const result = managedNodeHistory([
      managedNode({ id: "active", desiredState: "running", phase: "ready", updatedAt: "2026-07-24T00:00:00Z" }),
      managedNode({ id: "deleting", desiredState: "deleted", phase: "deleting", updatedAt: "2026-07-23T00:00:00Z" }),
      managedNode({ id: "older", desiredState: "deleted", phase: "deleted", updatedAt: "2026-07-20T00:00:00Z" }),
      managedNode({ id: "newer", desiredState: "deleted", phase: "deleted", updatedAt: "2026-07-22T00:00:00Z" }),
    ]);

    assert.deepEqual(result.map((node) => node.id), ["newer", "older"]);
  });
});
