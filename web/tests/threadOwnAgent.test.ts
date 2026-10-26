import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { threadOwnAgentId } from "../src/lib/threadRuntime.ts";

const run = (logicalAgentId?: string) => ({ logicalAgentId });

describe("threadOwnAgentId", () => {
  it("names the agent that ran the thread's latest turn", () => {
    assert.equal(
      threadOwnAgentId({ agentRuns: [run("agt_a"), run("agt_b")], participantAgentIds: ["agt_a"] }),
      "agt_b",
    );
  });

  it("skips legacy runs without an id and falls back to the room's first agent", () => {
    assert.equal(threadOwnAgentId({ agentRuns: [run("agt_a"), run()] }), "agt_a");
    assert.equal(threadOwnAgentId({ agentRuns: [], participantAgentIds: ["agt_p"] }), "agt_p");
  });

  it("names no agent for a team or project thread, whose room is the default", () => {
    assert.equal(threadOwnAgentId({ teamId: "team_1", agentRuns: [run("agt_a")] }), null);
    assert.equal(threadOwnAgentId({ projectId: "prj_1", agentRuns: [run("agt_a")] }), null);
    assert.equal(threadOwnAgentId(undefined), null);
  });
});
