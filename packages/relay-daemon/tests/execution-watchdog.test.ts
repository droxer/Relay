import assert from "node:assert/strict";
import { test } from "node:test";
import { ExecutionWatchdog } from "../src/execution-watchdog.js";

test("only renewed runs retain permission; expired execution stops once", () => {
  let now = 0;
  const stopped: string[] = [];
  const watchdog = new ExecutionWatchdog(() => now);
  watchdog.track("a", 100, () => stopped.push("a"));
  watchdog.track("b", 100, () => stopped.push("b"));
  now = 90;
  watchdog.renew("a", 100);
  now = 101;
  watchdog.tick(); watchdog.tick();
  assert.deepEqual(stopped, ["b"]);
  watchdog.forget("a");
  now = 200;
  watchdog.tick();
  assert.deepEqual(stopped, ["b"]);
});

test("a delayed poll observation cannot replace a newer heartbeat grant", () => {
  let now = 0;
  let stopped = false;
  const watchdog = new ExecutionWatchdog(() => now);
  watchdog.track("run", 100, () => { stopped = true; });
  watchdog.renew("run", 300, 2000);
  now = 50;
  watchdog.renew("run", 10, 1000);
  now = 100;
  watchdog.tick();
  assert.equal(stopped, false);
  now = 301;
  watchdog.tick();
  assert.equal(stopped, true);
});

test("an unreachable backend earns an expired lease one grace period, never two", () => {
  let now = 0;
  let unreachable = true;
  const stopped: string[] = [];
  const graced: string[] = [];
  const watchdog = new ExecutionWatchdog(() => now, {
    graceMs: 300, shouldGrace: () => unreachable, onGrace: (id: string) => graced.push(id),
  });
  watchdog.track("run", 100, () => stopped.push("run"));
  now = 100;
  watchdog.tick();
  assert.deepEqual(stopped, []);
  assert.deepEqual(graced, ["run"]);
  now = 399;
  watchdog.tick();
  assert.deepEqual(stopped, []);
  now = 400;
  watchdog.tick();
  assert.deepEqual(stopped, ["run"]);
});

test("a reachable backend that stops renewing gets no grace", () => {
  let now = 0;
  const stopped: string[] = [];
  const watchdog = new ExecutionWatchdog(() => now, { graceMs: 300, shouldGrace: () => false });
  watchdog.track("run", 100, () => stopped.push("run"));
  now = 100;
  watchdog.tick();
  assert.deepEqual(stopped, ["run"]);
});

test("losing reachability during the grace ends it, and a renewal restores a fresh grace", () => {
  let now = 0;
  let unreachable = true;
  const stopped: string[] = [];
  const watchdog = new ExecutionWatchdog(() => now, { graceMs: 300, shouldGrace: () => unreachable });
  watchdog.track("a", 100, () => stopped.push("a"));
  watchdog.track("b", 100, () => stopped.push("b"));
  now = 100;
  watchdog.tick();
  // The backend answers again and renews "a" but no longer grants "b".
  watchdog.renew("a", 100);
  unreachable = false;
  now = 150;
  watchdog.tick();
  assert.deepEqual(stopped, ["b"]);
  unreachable = true;
  now = 200;
  watchdog.tick();
  assert.deepEqual(stopped, ["b"]);
  now = 499;
  watchdog.tick();
  assert.deepEqual(stopped, ["b"]);
});
