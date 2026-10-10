import assert from "node:assert/strict";
import test from "node:test";
import type { ExecutionManager } from "../src/execution.js";
import { GuestPool, type GuestStartInput } from "../src/guest-pool.js";
import type { ActiveOrchestratorSession } from "../src/sandbox-session.js";

interface Boot {
  input: GuestStartInput;
  resolve(): void;
  reject(error: Error): void;
  closed: boolean;
}

/** A pool whose guests boot only when the test says so. */
function controlledPool(capacity: number) {
  const boots: Boot[] = [];
  const pool = new GuestPool({
    capacity,
    boxName: (slot) => `box-${slot}`,
    createManager: () => ({}) as ExecutionManager,
    start: (input) => new Promise<ActiveOrchestratorSession>((resolve, reject) => {
      const boot: Boot = {
        input,
        closed: false,
        resolve: () => resolve({
          session: {} as ActiveOrchestratorSession["session"],
          close: async () => { boot.closed = true; },
        }),
        reject,
      };
      boots.push(boot);
    }),
  });
  return { pool, boots };
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

test("each guest gets its own manager so readiness and the box never cross guests", async () => {
  const { pool, boots } = controlledPool(2);
  const a = pool.acquire("/w/a");
  const b = pool.acquire("/w/b");
  await tick();
  boots.forEach((boot) => boot.resolve());
  const [leaseA, leaseB] = await Promise.all([a, b]);
  assert.notEqual(leaseA.manager, leaseB.manager);
  assert.deepEqual(boots.map((boot) => boot.input.boxName), ["box-0", "box-1"]);
  leaseA.release();
  leaseB.release();
  await pool.close();
});

test("a failed boot frees its slot and wakes a run waiting for one", async () => {
  const { pool, boots } = controlledPool(1);
  const failing = pool.acquire("/w/a");
  await tick();
  let waiterSettled = false;
  const waiting = pool.acquire("/w/b").then((lease) => { waiterSettled = true; return lease; });
  await tick();
  assert.equal(boots.length, 1);
  assert.equal(waiterSettled, false);

  boots[0]!.reject(new Error("guest failed to boot"));
  await assert.rejects(failing, /guest failed to boot/);
  await tick();
  assert.equal(boots.length, 2);
  assert.equal(boots[1]!.input.boxName, "box-0");
  boots[1]!.resolve();
  (await waiting).release();
  await pool.close();
});

test("an aborted wait for a slot gives up without taking one", async () => {
  const { pool, boots } = controlledPool(1);
  const held = pool.acquire("/w/a");
  await tick();
  boots[0]!.resolve();
  const lease = await held;
  const abort = new AbortController();
  const waiting = pool.acquire("/w/b", abort.signal);
  await tick();
  abort.abort();
  await assert.rejects(waiting, /cancelled/);
  assert.equal(boots.length, 1);
  lease.release();
  await pool.close();
});

test("discovery borrows a booted guest even when every slot is busy", async () => {
  const { pool, boots } = controlledPool(1);
  const held = pool.acquire("/w/thread");
  await tick();
  boots[0]!.resolve();
  const run = await held;
  const borrowed = await pool.acquireAny("/w/root");
  assert.equal(borrowed.workspace, run.workspace);
  assert.equal(boots.length, 1);
  borrowed.release();
  run.release();
  await pool.close();
});

test("discovery boots a guest on the node root when none exists", async () => {
  const { pool, boots } = controlledPool(1);
  const acquiring = pool.acquireAny("/w/root");
  await tick();
  assert.equal(boots[0]!.input.workspace, "/w/root");
  boots[0]!.resolve();
  (await acquiring).release();
  await pool.close();
});

test("closing during a boot stops that guest once it comes up", async () => {
  const { pool, boots } = controlledPool(1);
  const acquiring = pool.acquire("/w/a");
  await tick();
  const closing = pool.close();
  boots[0]!.resolve();
  await closing;
  assert.equal(boots[0]!.closed, true);
  (await acquiring).release();
  await assert.rejects(pool.acquire("/w/b"), /closed/);
});
