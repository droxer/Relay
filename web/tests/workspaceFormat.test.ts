import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { taskAssigneeName } from "../src/lib/workspaceFormat.js";
import type { EmployeeAgent } from "../src/types.js";

const agent = (id: string, displayName: string): EmployeeAgent => ({
  id,
  supervisorEmployeeId: "employee-1",
  displayName,
  executorKind: "claude",
  skillPolicy: {},
  toolPolicy: {},
  modelPolicy: {},
  enabled: true,
  availability: "ready",
  version: 1,
  placements: [],
  createdAt: "2026-09-01T00:00:00Z",
  updatedAt: "2026-09-01T00:00:00Z",
});

describe("taskAssigneeName", () => {
  it("resolves an assigned agent id to its display name", () => {
    const name = taskAssigneeName(
      { assignedAgentId: "agent-1", assignedAgent: "claude" },
      [agent("agent-1", "Reviewer")],
    );
    assert.equal(name, "Reviewer");
  });

  it("falls back to the executor CLI label when the id is unknown", () => {
    const name = taskAssigneeName(
      { assignedAgentId: "agent-missing", assignedAgent: "codex" },
      [agent("agent-1", "Reviewer")],
    );
    assert.equal(name, "Codex");
  });

  it("falls back to the executor CLI label when no roster is provided", () => {
    assert.equal(taskAssigneeName({ assignedAgent: "kimi" }, undefined), "Kimi");
  });

  it("returns empty when nothing is assigned", () => {
    assert.equal(taskAssigneeName({}, [agent("agent-1", "Reviewer")]), "");
  });
});
