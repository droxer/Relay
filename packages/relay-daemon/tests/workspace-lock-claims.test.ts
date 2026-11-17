import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { acquireWorkspaceLockClaim } from "../src/workspace-lock-claims.js";

async function fixture(work: (path: string, directory: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "relay-workspace-claims-"));
  const path = join(root, "workspace.lock");
  try { await work(path, `${path}.claims`); }
  finally { rmSync(root, { recursive: true, force: true }); }
}

test("claim contenders enter one at a time and cancelled waiters leave no claims", async () => {
  await fixture(async (path, directory) => {
    const first = await acquireWorkspaceLockClaim(path);
    const cancelled = new AbortController();
    let waits = 0;
    const second = acquireWorkspaceLockClaim(path, cancelled.signal, async () => { waits++; });
    // Install the rejection handler before triggering cancellation.
    const rejected = assert.rejects(second, { name: "AbortError" });
    cancelled.abort();
    await rejected;
    assert.ok(waits > 0);
    assert.equal(readdirSync(directory).length, 1);
    first();
    const third = await acquireWorkspaceLockClaim(path);
    third();
    assert.deepEqual(readdirSync(directory), []);
  });
});

test("a failed wait observer releases its own claim", async () => {
  await fixture(async (path, directory) => {
    const release = await acquireWorkspaceLockClaim(path);
    try {
      await assert.rejects(acquireWorkspaceLockClaim(path, undefined, async () => {
        throw new Error("observer failed");
      }), /observer failed/);
      assert.equal(readdirSync(directory).length, 1);
    } finally { release(); }
  });
});

test("a live incomplete claim blocks contenders until it is withdrawn", async () => {
  await fixture(async (path, directory) => {
    mkdirSync(directory);
    const partial = join(directory, `${process.pid}-partial`);
    writeFileSync(partial, "");
    const controller = new AbortController();
    let entered = false;
    const pending = acquireWorkspaceLockClaim(path, controller.signal, async () => {
      assert.equal(entered, false);
      unlinkSync(partial);
    }).then(release => { entered = true; release(); });
    await pending;
    assert.equal(entered, true);
    assert.deepEqual(readdirSync(directory), []);
  });
});

test("dead unique claims and their unpublished tickets are reclaimed", async () => {
  await fixture(async (path, directory) => {
    mkdirSync(directory);
    const id = "999999999-dead";
    writeFileSync(join(directory, id), "null");
    writeFileSync(join(directory, `.${id}.ticket`), "123");
    const release = await acquireWorkspaceLockClaim(path);
    release();
    assert.deepEqual(readdirSync(directory), []);
  });
});

test("a daemon that crashes holding a mutation claim cannot stall its replacement", async () => {
  await fixture(async (path, directory) => {
    const script = `
      const { acquireWorkspaceLockClaim } = await import(process.argv[1]);
      await acquireWorkspaceLockClaim(process.argv[2]);
      process.stdout.write('ready');
      setInterval(() => {}, 1000);
    `;
    const child = spawn(process.execPath, ["--input-type=module", "-e", script,
      new URL("../src/workspace-lock-claims.js", import.meta.url).href, path], { stdio: "pipe" });
    const closed = once(child, "close");
    try {
      const ready = once(child.stdout!, "data");
      await Promise.race([ready, closed.then(() => { throw new Error("claim worker exited before ready"); })]);
      assert.equal(readdirSync(directory).length, 1);
      child.kill();
      await closed;
      const release = await acquireWorkspaceLockClaim(path, AbortSignal.timeout(5000));
      release();
      assert.deepEqual(readdirSync(directory), []);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await closed;
    }
  });
});

test("an already cancelled claim never creates a file", async () => {
  await fixture(async (path, directory) => {
    await assert.rejects(acquireWorkspaceLockClaim(path, AbortSignal.abort("stopped")), error => error === "stopped");
    assert.equal(existsSync(directory), false);
  });
});

test("multiple independent contenders preserve exclusion", async () => {
  await fixture(async path => {
    let active = 0, peak = 0;
    await Promise.all(Array.from({ length: 12 }, async () => {
      const release = await acquireWorkspaceLockClaim(path);
      try {
        peak = Math.max(peak, ++active);
        await delay(2);
        active--;
      } finally { release(); }
    }));
    assert.equal(peak, 1);
  });
});
