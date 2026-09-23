import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { useComposerTargetStore } from "../src/lib/composerTargetStore.js";

const reviewer = { id: "agt_reviewer", executorKind: "codex" as const };

describe("composer target store", () => {
  beforeEach(() => {
    useComposerTargetStore.setState(useComposerTargetStore.getInitialState(), true);
  });

  it("starts on claude, no agent, no staged team, the whole room, no computer", () => {
    const state = useComposerTargetStore.getState();
    assert.equal(state.activeAgent, "claude");
    assert.equal(state.activeLogicalAgentId, null);
    assert.equal(state.pendingThreadTeamId, null);
    assert.equal(state.projectRoomTarget, true);
    assert.equal(state.newThreadNodeId, null);
  });

  it("follows a resolved target and keeps the executor when the target clears", () => {
    const { setActiveTarget } = useComposerTargetStore.getState();
    setActiveTarget(reviewer);
    assert.equal(useComposerTargetStore.getState().activeLogicalAgentId, "agt_reviewer");
    assert.equal(useComposerTargetStore.getState().activeAgent, "codex");

    setActiveTarget(null);
    assert.equal(useComposerTargetStore.getState().activeLogicalAgentId, null);
    assert.equal(useComposerTargetStore.getState().activeAgent, "codex");
  });

  it("picking an agent drops a staged team and narrows the project round to that agent", () => {
    const { pickTeam, pickAgent } = useComposerTargetStore.getState();
    pickTeam("team_1");
    pickAgent(reviewer);

    const state = useComposerTargetStore.getState();
    assert.equal(state.pendingThreadTeamId, null);
    assert.equal(state.projectRoomTarget, false);
    assert.equal(state.activeLogicalAgentId, "agt_reviewer");
    assert.equal(state.activeAgent, "codex");
  });

  it("picking the room widens the round back to the whole roster", () => {
    const { pickAgent, pickRoom } = useComposerTargetStore.getState();
    pickAgent(reviewer);
    pickRoom();
    assert.equal(useComposerTargetStore.getState().projectRoomTarget, true);
  });

  it("stages and clears a team pick", () => {
    const { pickTeam, clearPendingTeam } = useComposerTargetStore.getState();
    pickTeam("team_1");
    assert.equal(useComposerTargetStore.getState().pendingThreadTeamId, "team_1");
    clearPendingTeam();
    assert.equal(useComposerTargetStore.getState().pendingThreadTeamId, null);
  });

  it("sets the new-thread computer directly or from the previous pick", () => {
    const { setNewThreadNodeId } = useComposerTargetStore.getState();
    setNewThreadNodeId("node_a");
    setNewThreadNodeId((previous) => (previous === "node_a" ? "node_b" : "unexpected"));
    assert.equal(useComposerTargetStore.getState().newThreadNodeId, "node_b");
  });

  it("does not notify subscribers when an updater returns the same computer", () => {
    const { setNewThreadNodeId } = useComposerTargetStore.getState();
    setNewThreadNodeId("node_a");
    const before = useComposerTargetStore.getState();
    setNewThreadNodeId((previous) => previous);
    assert.equal(useComposerTargetStore.getState(), before);
  });
});
