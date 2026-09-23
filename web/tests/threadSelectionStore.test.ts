import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { activeSessionStorageKey, useRelayStore } from "../src/lib/store.js";

// Minimal Storage stand-in: the store persists the opened thread per employee.
function installStorage(): Map<string, string> {
  const data = new Map<string, string>();
  (globalThis as { localStorage?: Pick<Storage, "getItem" | "setItem" | "removeItem"> }).localStorage = {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => { data.set(key, value); },
    removeItem: (key) => { data.delete(key); },
  };
  return data;
}

describe("thread selection in the relay store", () => {
  let storage: Map<string, string>;

  beforeEach(() => {
    storage = installStorage();
    useRelayStore.setState(useRelayStore.getInitialState(), true);
    useRelayStore.getState().setSelectedEmployee("emp_1");
  });

  afterEach(() => {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  });

  it("starts with no thread open and nothing being composed", () => {
    const state = useRelayStore.getState();
    assert.equal(state.selectedSessionId, undefined);
    assert.equal(state.activeSessionId, null);
    assert.equal(state.composingNew, false);
  });

  it("opening a thread selects it, stops composing, and remembers it for the employee", () => {
    const { startComposing, openSession } = useRelayStore.getState();
    startComposing();
    openSession("s_1");

    const state = useRelayStore.getState();
    assert.equal(state.composingNew, false);
    assert.equal(state.selectedSessionId, "s_1");
    assert.equal(state.activeSessionId, "s_1");
    assert.equal(storage.get(activeSessionStorageKey("emp_1")), "s_1");
  });

  it("starting a new thread clears the selection and forgets the remembered thread", () => {
    const { openSession, startComposing } = useRelayStore.getState();
    openSession("s_1");
    startComposing();

    const state = useRelayStore.getState();
    assert.equal(state.composingNew, true);
    assert.equal(state.selectedSessionId, undefined);
    assert.equal(state.activeSessionId, null);
    assert.equal(storage.has(activeSessionStorageKey("emp_1")), false);
  });

  it("clearing the selection leaves the composing flag alone", () => {
    const { openSession, setComposingNew, clearSelection } = useRelayStore.getState();
    openSession("s_1");
    setComposingNew(true);
    clearSelection();

    const state = useRelayStore.getState();
    assert.equal(state.composingNew, true);
    assert.equal(state.selectedSessionId, undefined);
    assert.equal(state.activeSessionId, null);
  });

  it("adopting a derived thread does not overwrite the remembered one", () => {
    storage.set(activeSessionStorageKey("emp_1"), "s_remembered");
    useRelayStore.getState().adoptActiveSessionId("s_newest");

    assert.equal(useRelayStore.getState().activeSessionId, "s_newest");
    assert.equal(storage.get(activeSessionStorageKey("emp_1")), "s_remembered");
  });

  it("does not persist without a selected employee", () => {
    useRelayStore.getState().setSelectedEmployee("");
    useRelayStore.getState().setActiveSessionId("s_1");
    assert.equal(useRelayStore.getState().activeSessionId, "s_1");
    assert.equal(storage.size, 0);
  });
});
