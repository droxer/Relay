import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { threadOwnAgentId } from "../src/lib/threadRuntime.ts";

const run = (logicalAgentId?: string) => ({ logicalAgentId });
const round = (
  workScope: { kind: "thread" } | { kind: "task"; taskId: string },
  agentIds: string[],
) => ({ workScope, assignments: agentIds.map((agentId) => ({ agentId })) });

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

  it("names no agent for a team thread or a project room, whose room is the default", () => {
    assert.equal(threadOwnAgentId({ teamId: "team_1", agentRuns: [run("agt_a")] }), null);
    assert.equal(threadOwnAgentId({ projectId: "prj_1", agentRuns: [run("agt_a")] }), null);
    assert.equal(
      threadOwnAgentId({ projectId: "prj_1", collaborationRounds: [round({ kind: "thread" }, ["agt_a"])] }),
      null,
    );
    assert.equal(threadOwnAgentId(undefined), null);
  });

  it("names the agent of a single-agent task running in a project thread", () => {
    assert.equal(
      threadOwnAgentId({
        projectId: "prj_1",
        agentRuns: [run("agt_lead")],
        collaborationRounds: [
          round({ kind: "task", taskId: "tsk_1" }, ["agt_dev"]),
          round({ kind: "thread" }, ["agt_lead"]),
        ],
      }),
      "agt_dev",
    );
  });

  it("keeps the crew for a project task the whole crew runs", () => {
    assert.equal(
      threadOwnAgentId({
        projectId: "prj_1",
        collaborationRounds: [round({ kind: "task", taskId: "tsk_1" }, ["agt_lead", "agt_dev", "agt_lead"])],
      }),
      null,
    );
  });
});
