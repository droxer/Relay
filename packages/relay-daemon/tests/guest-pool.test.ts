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
function controlledPool(capacity: number, options: Record<string, number> = {}) {
  const boots: Boot[] = [];
  const pool = new GuestPool({
    ...options,
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
  await assert.rejects(acquiring, /closed/);
  await assert.rejects(pool.acquire("/w/b"), /closed/);
});

test("a pool reports a borrowable guest only once one has booted", async () => {
  const { pool, boots } = controlledPool(1);
  assert.equal(pool.hasBootedGuest(), false);
  const acquiring = pool.acquire("/w/thread");
  await tick();
  assert.equal(pool.hasBootedGuest(), false);
  boots[0]!.resolve();
  const lease = await acquiring;
  assert.equal(pool.hasBootedGuest(), true);
  lease.release();
  await pool.close();
  assert.equal(pool.hasBootedGuest(), false);
});

test("cancelling a boot waiter releases it without recycling the booting slot", async () => {
  const { pool, boots } = controlledPool(1);
  const abort = new AbortController();
  const acquiring = pool.acquire("/w/a", abort.signal);
  await tick();
  abort.abort();
  let result = "pending";
  void acquiring.then(() => { result = "resolved"; }, () => { result = "cancelled"; });
  await tick();
  try {
    assert.equal(result, "cancelled");
    const other = pool.acquire("/w/b");
    await tick();
    assert.equal(boots.length, 1, "an unfinished boot must keep its slot fenced");
    boots[0]!.resolve();
    await tick();
    assert.equal(boots.length, 2);
    boots[1]!.resolve();
    (await other).release();
  } finally {
    boots.forEach(boot => boot.resolve());
    await acquiring.then(lease => lease.release(), () => undefined);
    await pool.close();
  }
});

test('boot deadlines quarantine the slot until late boot cleanup proves it stopped', async () => {
  const { pool, boots } = controlledPool(1, { bootTimeoutMs: 10 });
  let error: unknown;
  const acquiring = pool.acquire('/w/a').catch(reason => { error = reason; });
  await new Promise(resolve => setTimeout(resolve, 30));
  try {
    assert.match(String(error), /timed out/);
    const next = pool.acquire('/w/b');
    await tick();
    assert.equal(boots.length, 1);
    boots[0]!.resolve();
    await tick();
    assert.equal(boots[0]!.closed, true);
    assert.equal(boots.length, 2);
    boots[1]!.resolve();
    (await next).release();
  } finally {
    boots.forEach(boot => boot.resolve());
    await acquiring;
    await pool.close();
  }
});

test('closing a pool has a deadline and cleans up a boot that finishes later', async () => {
  const { pool, boots } = controlledPool(1, { closeTimeoutMs: 10 });
  const acquiring = pool.acquire('/w/a').catch(() => undefined);
  await tick();
  let error: unknown;
  const closing = pool.close().catch(reason => { error = reason; });
  await new Promise(resolve => setTimeout(resolve, 30));
  try { assert.match(String(error), /timed out/); }
  finally { boots[0]!.resolve(); await acquiring; await closing; }
  await tick();
  assert.equal(boots[0]!.closed, true);
});

test('failed guest teardown never frees its slot for another workspace', async () => {
  let starts = 0;
  const pool = new GuestPool({
    capacity: 1, boxName: () => 'owned', createManager: () => ({}) as ExecutionManager,
    start: async () => { starts++; return { session: {} as ActiveOrchestratorSession['session'], close: async () => { throw new Error('stop failed'); } }; },
  });
  (await pool.acquire('/w/a')).release();
  await assert.rejects(pool.acquire('/w/b'), /stop failed/);
  const abort = new AbortController();
  const waiting = pool.acquire('/w/c', abort.signal);
  await tick();
  abort.abort();
  await assert.rejects(waiting, /cancelled/);
  assert.equal(starts, 1);
  await pool.close();
});

test('uncertain startup cleanup keeps the slot fenced and surfaces its failure', async () => {
  const { ExecutionCleanupError } = await import('../src/execution-deadline.js');
  let starts = 0;
  const failures: unknown[] = [];
  const pool = new GuestPool({
    capacity: 1, boxName: () => 'uncertain', createManager: () => ({}) as ExecutionManager,
    onUnconfirmed: error => failures.push(error),
    start: async () => { starts++; throw new ExecutionCleanupError('cleanup unconfirmed'); },
  });
  await assert.rejects(pool.acquire('/w/a'), /cleanup unconfirmed/);
  const abort = new AbortController();
  const waiting = pool.acquire('/w/b', abort.signal);
  await tick(); abort.abort();
  await assert.rejects(waiting, /cancelled/);
  assert.equal(starts, 1);
  assert.equal(failures.length, 1);
  await pool.close();
});

test('boot concurrency is independent of resident capacity and waiting remains cancellable', async () => {
  const { pool, boots } = controlledPool(3, { maxConcurrentBoots: 1 });
  const a = pool.acquire('/w/a');
  const cancel = new AbortController();
  const b = pool.acquire('/w/b', cancel.signal);
  await tick();
  assert.equal(boots.length, 1);
  cancel.abort();
  await assert.rejects(b, /cancelled/);
  boots[0]!.resolve();
  const first = await a;
  const c = pool.acquire('/w/c');
  await tick();
  assert.equal(boots.length, 2);
  boots[1]!.resolve();
  const second = await c;
  assert.notEqual(first.workspace, second.workspace);
  first.release(); second.release();
  await pool.close();
});

test('a timed-out boot keeps its boot budget until the underlying operation settles', async () => {
  const { pool, boots } = controlledPool(2, { maxConcurrentBoots: 1, bootTimeoutMs: 10 });
  const first = pool.acquire('/w/a');
  await assert.rejects(first, /deadline|timed out/i);
  const second = pool.acquire('/w/b');
  await tick();
  assert.equal(boots.length, 1);
  boots[0]!.resolve();
  await tick();
  assert.equal(boots.length, 2);
  boots[1]!.resolve();
  (await second).release();
  await pool.close();
});
