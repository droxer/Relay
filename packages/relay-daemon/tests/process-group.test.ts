import assert from "node:assert/strict";
import test from "node:test";
import { processGroupAlive } from "../src/process-group.js";

const proc = (stats: Record<string, string | Error>) => ({
  list: () => ["self", "cpuinfo", ...Object.keys(stats)],
  stat: (pid: string) => {
    const stat = stats[pid];
    if (stat instanceof Error) throw stat;
    return stat ?? "";
  },
});
const exists = () => undefined;
const enoent = () => Object.assign(new Error("gone"), { code: "ENOENT" });
const eacces = () => Object.assign(new Error("denied"), { code: "EACCES" });
const refused = () => { throw Object.assign(new Error("EPERM"), { code: "EPERM" }); };

test("a group with a running member is alive", () => {
  assert.equal(processGroupAlive(200, "linux", proc({ "201": "201 (agent) S 1 200 200 0" }), exists), true);
});

test("a group holding only zombies cannot execute", () => {
  // A killed orphan stays a zombie when PID 1 never reaps it.
  assert.equal(processGroupAlive(200, "linux", proc({ "201": "201 (agent) Z 1 200 200 0", "202": "202 (x) X 1 200 200 0" }), exists), false);
});

test("other groups and vanished processes do not count", () => {
  assert.equal(processGroupAlive(200, "linux", proc({ "300": "300 (other) S 1 300 300 0", "201": enoent(), "202": "202 (z) Z 1 200 200 0" }), exists), false);
});

test("a group the kernel reports but /proc cannot show is retained", () => {
  // A hidepid mount, or a race: no evidence that the group stopped.
  assert.equal(processGroupAlive(200, "linux", proc({ "300": "300 (other) S 1 300 300 0" }), exists), true);
});

test("a command name with spaces and parentheses is parsed from its last paren", () => {
  assert.equal(processGroupAlive(200, "linux", proc({ "201": "201 (a) b (c) R 1 200 200 0" }), exists), true);
});

test("unreadable evidence throws so the run is retained", () => {
  assert.throws(() => processGroupAlive(200, "linux", proc({ "201": eacces() }), exists), /denied/);
});

test("the kernel's answer comes first: no group is gone, a refused probe is unknown", () => {
  const unread = proc({ "201": "201 (agent) S 1 200 200 0" });
  assert.equal(processGroupAlive(200, "linux", unread, () => { throw Object.assign(new Error("none"), { code: "ESRCH" }); }), false);
  assert.throws(() => processGroupAlive(200, "linux", unread, refused), /EPERM/);
  // Off Linux there is no /proc to rule out zombies: an existing group is alive.
  assert.equal(processGroupAlive(200, "darwin", unread, exists), true);
});

test("macOS can verify exit after a refused probe when the group contains only zombies", () => {
  const states = () => "  200 Zs\n  300 S\n  200 Z+\n";
  assert.equal(processGroupAlive(200, "darwin", proc({}), refused, states), false);
});

test("macOS retains a group after a refused probe if a live member remains or evidence is incomplete", () => {
  for (const states of ["200 Z\n200 S\n", "300 S\n", "200 Z\n200\n"]) {
    assert.throws(() => processGroupAlive(200, "darwin", proc({}), refused, () => states), /EPERM/);
  }
  const unavailable = () => { throw Object.assign(new Error("process table unavailable"), { code: "ESRCH" }); };
  assert.throws(() => processGroupAlive(200, "darwin", proc({}), refused, unavailable), /EPERM/);
});
