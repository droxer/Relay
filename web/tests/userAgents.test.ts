import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { dedupeAgentsById } from "../src/lib/userAgents.js";
import type { UserAgent } from "../src/types.js";

function agent(id: string): UserAgent {
  return {
    id,
    supervisorUserId: "alice",
    displayName: `Agent ${id}`,
    executorKind: "codex",
    skillPolicy: {},
    toolPolicy: {},
    modelPolicy: {},
    enabled: true,
    version: 1,
    availability: "ready",
    placements: [],
    createdAt: "2026-07-19T00:00:00Z",
    updatedAt: "2026-07-19T00:00:00Z",
  };
}

describe("dedupeAgentsById", () => {
  it("keeps the first occurrence of each agent id", () => {
    const result = dedupeAgentsById([agent("a"), agent("b"), agent("a")]);

    assert.deepEqual(result.map((item) => item.id), ["a", "b"]);
  });

  it("returns an empty list unchanged", () => {
    assert.deepEqual(dedupeAgentsById([]), []);
  });
});
