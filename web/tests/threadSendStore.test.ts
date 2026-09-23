import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { useThreadSendStore } from "../src/lib/threadSendStore.js";

const echo = { id: "evt_1", text: "ship it" };

describe("thread send store", () => {
  beforeEach(() => {
    useThreadSendStore.setState(useThreadSendStore.getInitialState(), true);
  });

  it("starts idle with no echoed turn", () => {
    const state = useThreadSendStore.getState();
    assert.equal(state.pendingUserMessage, null);
    assert.equal(state.dispatching, false);
  });

  it("a composer send echoes the turn and marks the dispatch in flight", () => {
    useThreadSendStore.getState().beginSend(echo);
    const state = useThreadSendStore.getState();
    assert.deepEqual(state.pendingUserMessage, echo);
    assert.equal(state.dispatching, true);
  });

  it("ending the dispatch keeps the echo until the persisted turn arrives", () => {
    const { beginSend, endDispatch } = useThreadSendStore.getState();
    beginSend(echo);
    endDispatch();
    const state = useThreadSendStore.getState();
    assert.equal(state.dispatching, false);
    assert.deepEqual(state.pendingUserMessage, echo);
  });

  it("a recovery dispatch is in flight without echoing a turn", () => {
    useThreadSendStore.getState().beginDispatch();
    const state = useThreadSendStore.getState();
    assert.equal(state.dispatching, true);
    assert.equal(state.pendingUserMessage, null);
  });

  it("drops the echo on its own, leaving the dispatch flag alone", () => {
    const { beginSend, dropPendingMessage } = useThreadSendStore.getState();
    beginSend(echo);
    dropPendingMessage();
    const state = useThreadSendStore.getState();
    assert.equal(state.pendingUserMessage, null);
    assert.equal(state.dispatching, true);
  });

  it("dropping an absent echo does not notify subscribers", () => {
    const before = useThreadSendStore.getState();
    before.dropPendingMessage();
    assert.equal(useThreadSendStore.getState(), before);
  });
});
