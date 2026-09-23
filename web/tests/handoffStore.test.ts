import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { useHandoffStore } from "../src/lib/handoffStore.js";

describe("handoff draft store", () => {
  beforeEach(() => {
    useHandoffStore.setState(useHandoffStore.getInitialState(), true);
  });

  it("starts closed with no target and an empty note", () => {
    const state = useHandoffStore.getState();
    assert.equal(state.open, false);
    assert.equal(state.agentId, "");
    assert.equal(state.note, "");
  });

  it("records the open flag, target, and note independently", () => {
    const { setOpen, setAgentId, setNote } = useHandoffStore.getState();
    setOpen(true);
    setAgentId("agt_reviewer");
    setNote("please double-check the migration");

    const state = useHandoffStore.getState();
    assert.equal(state.open, true);
    assert.equal(state.agentId, "agt_reviewer");
    assert.equal(state.note, "please double-check the migration");
  });

  it("closes the panel and clears the note after a send but keeps the target", () => {
    const { setOpen, setAgentId, setNote, finishSend } = useHandoffStore.getState();
    setOpen(true);
    setAgentId("agt_reviewer");
    setNote("draft");

    finishSend();

    const state = useHandoffStore.getState();
    assert.equal(state.open, false);
    assert.equal(state.note, "");
    assert.equal(state.agentId, "agt_reviewer");
  });

  it("replaces state instead of mutating the previous snapshot", () => {
    const before = useHandoffStore.getState();
    before.setNote("changed");
    assert.equal(before.note, "");
    assert.notEqual(useHandoffStore.getState(), before);
  });
});
