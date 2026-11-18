import assert from "node:assert/strict";
import test from "node:test";
import { localExitProven, retireStaleGuests } from "../src/exit-proof.js";

const BOOT = 1_000_000;
const gone = () => { throw Object.assign(new Error("ESRCH"), { code: "ESRCH" }); };
const denied = () => { throw Object.assign(new Error("EPERM"), { code: "EPERM" }); };
const alive = () => true;

test("a local run's exit requires a vanished process group", () => {
  assert.equal(localExitProven({ processGroup: 42, bootAt: BOOT }, gone), true);
  assert.equal(localExitProven({ processGroup: 42, bootAt: BOOT }, alive), false);
  assert.equal(localExitProven({ processGroup: 42, bootAt: BOOT }, denied), false);
  // Admitted but never recorded as spawned: nothing to prove it by.
  assert.equal(localExitProven({}, gone), false);
});

test("retiring stale guests removes only this computer's boxes and confirms they are gone", async () => {
  let boxes = ["relay-node", "relay-node-1", "relay-node-extra", "relay-other"];
  const runtime = {
    listInfo: async () => boxes.map((name) => ({ name })),
    remove: async (name: string) => { boxes = boxes.filter((box) => box !== name); },
  };
  assert.equal(await retireStaleGuests(runtime, "relay-node"), true);
  assert.deepEqual(boxes, ["relay-node-extra", "relay-other"]);
});

test("a guest that will not go away proves nothing", async () => {
  const runtime = {
    listInfo: async () => [{ name: "relay-node" }],
    remove: async () => { throw new Error("busy"); },
  };
  assert.equal(await retireStaleGuests(runtime, "relay-node"), false);
});

test("a guest listing that returns after cancellation cannot start removing guests", async () => {
  let finishListing!: (guests: Array<{ name: string }>) => void;
  const listing = new Promise<Array<{ name: string }>>(resolve => { finishListing = resolve; });
  let removals = 0;
  const stop = new AbortController();
  const recovery = retireStaleGuests({
    listInfo: () => listing,
    remove: async () => { removals++; },
  }, "relay-node", stop.signal);
  stop.abort();
  finishListing([{ name: "relay-node" }]);
  await assert.rejects(recovery, { name: "AbortError" });
  assert.equal(removals, 0);
});

test("wall-clock jumps never bypass process-group evidence", (t) => {
  let now = BOOT;
  t.mock.method(Date, "now", () => now);
  for (const change of [-3_600_000, 180_000, 86_400_000]) {
    now = BOOT + change;
    let probes = 0;
    assert.equal(localExitProven({ processGroup: 42, bootAt: BOOT }, () => { probes++; }), false);
    assert.equal(probes, 1);
  }
});
