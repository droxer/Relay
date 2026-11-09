import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { threadSendKey, useThreadSendStore } from "../src/lib/threadSendStore.js";
const echo = { id: "evt_1", text: "ship it" };
const a = threadSendKey("alice", "A");
const b = threadSendKey("alice", "B");
describe("thread send store", () => {
  beforeEach(() => useThreadSendStore.setState(useThreadSendStore.getInitialState(), true));
  it("isolates concurrent operations and keeps the accepted echo", () => {
    const store = useThreadSendStore.getState();
    const first = store.beginSend(a, echo);
    store.beginSend(b, { id: "B", text: "B" });
    store.endDispatch(a, first);
    assert.equal(useThreadSendStore.getState().operations[a].dispatching, false);
    assert.deepEqual(useThreadSendStore.getState().operations[a].pendingUserMessage, echo);
    assert.equal(useThreadSendStore.getState().operations[b].dispatching, true);
    store.dropPendingMessage(a, first);
    assert.equal(useThreadSendStore.getState().operations[a], undefined);
  });
  it("ignores cleanup from an older operation", () => {
    const store = useThreadSendStore.getState();
    const old = store.beginSend(a, echo);
    const current = store.beginSend(a, { id: "new", text: "new" });
    store.dropPendingMessage(a, old);
    store.endDispatch(a, old);
    assert.equal(useThreadSendStore.getState().operations[a].id, current);
    assert.equal(useThreadSendStore.getState().operations[a].dispatching, true);
  });
  it("moves a draft operation to its accepted Thread without losing Stop", () => {
    const store = useThreadSendStore.getState();
    const draft = threadSendKey("alice", undefined, 1);
    const id = store.beginSend(draft, echo, true);
    store.requestStop(draft);
    store.acceptThread(draft, id, a);
    assert.equal(useThreadSendStore.getState().operations[draft], undefined);
    assert.equal(useThreadSendStore.getState().operations[a].stopRequested, true);
    assert.equal(useThreadSendStore.getState().operations[a].openingTurn, true);
  });
  it("recovery finishes without retaining an empty operation", () => {
    const store = useThreadSendStore.getState();
    const id = store.beginDispatch(a);
    store.endDispatch(a, id);
    assert.deepEqual(useThreadSendStore.getState().operations, {});
  });
  it("isolates users and new draft generations", () => {
    assert.notEqual(a, threadSendKey("bob", "A"));
    assert.notEqual(threadSendKey("alice", undefined, 1), threadSendKey("alice", undefined, 2));
  });
});
