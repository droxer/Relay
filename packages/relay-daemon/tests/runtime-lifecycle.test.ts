import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createBoxliteEnvironment, type DaemonLogger } from "../src/index.js";
import { BoxliteRuntimeOwner } from "../src/sandbox-session.js";
import { acquireBoxliteHomeLock } from "../src/box.js";
import type { ExecutionManager } from "../src/execution.js";

test("the daemon environment reuses one native runtime across thread workspace switches", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "relay-runtime-lifecycle-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "runtime");
  let created = 0;
  let shutdowns = 0;
  const native = { shutdown: async () => { shutdowns++; }, close() {} };
  const owner = new BoxliteRuntimeOwner(home, async () => {
    if (++created > 1) throw new Error("Another BoxliteRuntime is already using directory");
    return native;
  });
  const mounts: string[] = [];
  const manager = {
    ensureImage: () => "/unused-rootfs",
    createSandbox: async (runtime, input) => {
      assert.equal(runtime, native);
      mounts.push(input.volumes[0]!.hostPath);
      return { name: input.boxName, raw: {} };
    },
    setActiveSandbox() {},
    stopActiveSandbox: async () => {},
    removeSandbox: async () => {},
    prepareWorkspace: async () => [501, 20],
    prepareAgentAuth: async () => {},
    prepareAgentSkills: async () => {},
    execStream: async () => { throw new Error("unused"); },
    runShell: async () => ({ exit_code: 0, stdout: "", stderr: "" }),
  } as ExecutionManager;
  const logger = {
    info() {}, warn() {}, error() {}, output() {},
  } satisfies DaemonLogger;
  const environment = createBoxliteEnvironment("sandbox-a", root, logger, {
    boxliteHome: home,
    executionManager: manager,
    runtimeOwner: owner,
  });
  for (const name of ["thread-a", "thread-b", "thread-a"]) {
    const workspace = join(root, name);
    mkdirSync(workspace, { recursive: true });
    const lease = await environment.acquireWorkspace(workspace);
    await lease.ensureAgentReady("codex");
    lease.release();
    assert.equal(shutdowns, 0);
    assert.throws(() => acquireBoxliteHomeLock(home), /Another Relay orchestrator/);
  }
  assert.deepEqual(mounts, ["thread-a", "thread-b", "thread-a"].map(name => join(root, name)));
  assert.equal(created, 1);
  await environment.close();
  await environment.close();
  assert.equal(shutdowns, 1);
  await assert.rejects(owner.get(), /closed/);
  assert.throws(() => acquireBoxliteHomeLock(home), /Another Relay orchestrator/);
});

test("concurrent runs on different threads each hold their own guest on the one runtime", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "relay-runtime-pool-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "runtime");
  let created = 0;
  const owner = new BoxliteRuntimeOwner(home, async () => {
    created++;
    return { shutdown: async () => {}, close() {} };
  });
  const booted: Array<{ box: string; mount: string }> = [];
  let stopped = 0;
  const manager = {
    ensureImage: () => "/unused-rootfs",
    createSandbox: async (_runtime, input) => {
      booted.push({ box: input.boxName, mount: input.volumes[0]!.hostPath });
      return { name: input.boxName, raw: {} };
    },
    setActiveSandbox() {},
    stopActiveSandbox: async () => { stopped++; },
    removeSandbox: async () => {},
    prepareWorkspace: async () => [501, 20],
    prepareAgentAuth: async () => {},
    prepareAgentSkills: async () => {},
    execStream: async () => { throw new Error("unused"); },
    runShell: async () => ({ exit_code: 0, stdout: "", stderr: "" }),
  } as ExecutionManager;
  const logger = { info() {}, warn() {}, error() {}, output() {} } satisfies DaemonLogger;
  const environment = createBoxliteEnvironment("sandbox-a", root, logger, {
    boxliteHome: home, executionManager: manager, runtimeOwner: owner, maxGuests: 2,
  });
  const [a, b, c] = ["thread-a", "thread-b", "thread-c"].map((name) => {
    const workspace = join(root, name);
    mkdirSync(workspace, { recursive: true });
    return workspace;
  });

  // Two threads run at once: two guests, each mounting only its own thread.
  const [leaseA, leaseB] = await Promise.all([environment.acquireWorkspace(a!), environment.acquireWorkspace(b!)]);
  assert.deepEqual(booted, [
    { box: "relay-sandbox-a", mount: a },
    { box: "relay-sandbox-a-1", mount: b },
  ]);
  assert.equal(created, 1);

  // A second run on a busy thread shares that thread's guest.
  const againA = await environment.acquireWorkspace(a!);
  assert.equal(booted.length, 2);
  againA.release();

  // A third thread waits for a slot instead of stopping a guest in use.
  let leaseC: Awaited<ReturnType<typeof environment.acquireWorkspace>> | undefined;
  const waiting = environment.acquireWorkspace(c!).then((lease) => { leaseC = lease; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(leaseC, undefined);
  assert.equal(stopped, 0);

  // Freeing thread A recycles its slot (and box name) for thread C.
  leaseA.release();
  await waiting;
  assert.equal(stopped, 1);
  assert.deepEqual(booted[2], { box: "relay-sandbox-a", mount: c });

  leaseB.release();
  leaseC!.release();
  await environment.close();
  assert.equal(stopped, 3);
  assert.equal(created, 1);
});

test("runtime initialization is shared and can retry after a constructor failure", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "relay-runtime-retry-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  let attempts = 0;
  const runtime = { close() {} };
  const owner = new BoxliteRuntimeOwner(home, async () => {
    if (++attempts === 1) throw new Error("initialization failed");
    return runtime;
  });
  await assert.rejects(owner.get(), /initialization failed/);
  const probe = acquireBoxliteHomeLock(home);
  probe.release();
  const values = await Promise.all([owner.get(), owner.get()]);
  assert.deepEqual(values, [runtime, runtime]);
  assert.equal(attempts, 2);
  await owner.close();
});

test("runtime owner closes initialization still in flight", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "relay-runtime-close-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  let finish!: (value: { shutdown(): Promise<void> }) => void;
  let shutdowns = 0;
  const owner = new BoxliteRuntimeOwner(home, () => new Promise(resolve => { finish = resolve; }));
  const starting = owner.get();
  const closing = owner.close();
  await assert.rejects(owner.get(), /closed/);
  finish({ shutdown: async () => { shutdowns++; } });
  await Promise.all([starting, closing]);
  assert.equal(shutdowns, 1);
});
