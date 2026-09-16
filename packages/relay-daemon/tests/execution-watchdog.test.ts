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
