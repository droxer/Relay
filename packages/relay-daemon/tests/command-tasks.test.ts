import assert from "node:assert/strict";
import test from "node:test";
import { CommandTasks } from "../src/command-tasks.js";

test("command tasks bound admission, deduplicate work, and preserve lane order", async () => {
  const stop = new AbortController();
  const tasks = new CommandTasks(stop.signal, error => { throw error; }, 2, 3);
  const events: string[] = [];
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  assert.equal(tasks.submit("a", async () => { events.push("a"); await held; }, {
    lane: "workspace", lease: { commandId: "a", leaseId: "lease-a" },
  }), true);
  assert.equal(tasks.submit("a", async () => { events.push("duplicate"); }), false);
  assert.equal(tasks.submit("b", async () => { events.push("b"); }, { lane: "workspace" }), true);
  assert.equal(tasks.submit("c", async () => { events.push("c"); }), true);
  assert.equal(tasks.submit("overflow", async () => {}), false);
  assert.deepEqual(tasks.leases(), [{ commandId: "a", leaseId: "lease-a" }]);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events, ["a", "c"], "a waiting lane must not occupy another worker");
  release();
  await new Promise(resolve => setImmediate(resolve));
  await tasks.close();
  assert.deepEqual(events, ["a", "c", "b"]);
  assert.deepEqual(tasks.leases(), []);
});

test("command tasks stop queued work on shutdown and settle failures", async () => {
  const stop = new AbortController();
  const errors: unknown[] = [];
  const tasks = new CommandTasks(stop.signal, error => { errors.push(error); }, 1);
  let queued = false;
  tasks.submit("active", async () => {
    await new Promise<void>(resolve => stop.signal.addEventListener("abort", () => resolve(), { once: true }));
    throw new Error("aborted");
  });
  tasks.submit("queued", async () => { queued = true; });
  await new Promise(resolve => setImmediate(resolve));
  stop.abort();
  await tasks.close();
  assert.equal(queued, false);
  assert.equal(errors.length, 1);
  assert.equal(tasks.submit("late", async () => {}), false);
});
