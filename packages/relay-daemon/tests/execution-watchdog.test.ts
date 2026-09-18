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
  // Apply wire observations dynamically so the regression also runs against
  // the old two-argument implementation, which ignored observation ordering.
  Reflect.apply(watchdog.renew, watchdog, ["run", 300, 2000]);
  now = 50;
  Reflect.apply(watchdog.renew, watchdog, ["run", 10, 1000]);
  now = 100;
  watchdog.tick();
  assert.equal(stopped, false);
  now = 301;
  watchdog.tick();
  assert.equal(stopped, true);
});
