import assert from "node:assert/strict";
import test from "node:test";
import { localExitProven, retireStaleGuests } from "../src/exit-proof.js";

const BOOT = 1_000_000;
const gone = () => { throw Object.assign(new Error("ESRCH"), { code: "ESRCH" }); };
const denied = () => { throw Object.assign(new Error("EPERM"), { code: "EPERM" }); };
const alive = () => true;

test("a local run's exit is proven only by a vanished group or a reboot", () => {
  assert.equal(localExitProven({ processGroup: 42, bootAt: BOOT }, gone, BOOT), true);
  assert.equal(localExitProven({ processGroup: 42, bootAt: BOOT }, alive, BOOT + 1000), false);
  // A reboot ends every process, and the recorded id may since belong to another.
  assert.equal(localExitProven({ processGroup: 42, bootAt: BOOT }, alive, BOOT + 10 * 60_000), true);
  assert.equal(localExitProven({ processGroup: 42, bootAt: BOOT }, denied, BOOT), false);
  // Admitted but never recorded as spawned: nothing to prove it by.
  assert.equal(localExitProven({}, gone, BOOT), false);
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
