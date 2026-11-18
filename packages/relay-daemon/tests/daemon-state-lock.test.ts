import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { acquireDaemonStateLock } from "../src/daemon-state-lock.js";

test("a live process excludes another daemon and a crash leaves reclaimable ownership", { timeout: 5_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "relay-state-lock-crash-"));
  const script = `
    const { acquireDaemonStateLock } = await import(process.argv[1]);
    await acquireDaemonStateLock(process.argv[2]);
    process.stdout.write("ready");
    setInterval(() => {}, 1_000);
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script,
    new URL("../src/daemon-state-lock.js", import.meta.url).href, root], { stdio: ["ignore", "pipe", "ignore"] });
  const closed = once(child, "close");
  try {
    await Promise.race([once(child.stdout!, "data"), closed.then(() => { throw new Error("State lock owner exited before startup."); })]);
    await assert.rejects(acquireDaemonStateLock(root), /already using this daemon state directory/);
    child.kill("SIGKILL");
    await closed;
    const release = await acquireDaemonStateLock(root);
    release();
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await closed;
    rmSync(root, { recursive: true, force: true });
  }
});
