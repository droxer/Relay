import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { workspaceLockDirectory } from "../src/workspace-run-gate.js";

// Pause after each process has observed the old owner's death. Release the
// first to acquire a new lock before the second resumes its stale observation.
const contender = String.raw`
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
const [root, id, moduleUrl] = process.argv.slice(1);
const { WorkspaceRunGate } = await import(moduleUrl);
const kill = process.kill.bind(process);
process.kill = (pid, signal) => {
  if (pid === 999999999 && signal === 0) {
    writeFileSync(join(root, 'observed-' + id), '');
    while (!existsSync(join(root, 'proceed-' + id))) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
  }
  return kill(pid, signal);
};
writeFileSync(join(root, 'started-' + id), '');
await new WorkspaceRunGate(root).run(join(root, 'project'), undefined, async () => {
  writeFileSync(join(root, 'entered-' + id), '');
  while (!existsSync(join(root, 'release-' + id))) await delay(5);
});
`;

async function waitUntil(ready: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!ready() && Date.now() < deadline) await delay(5);
  assert.ok(ready(), `worker did not reach ${description}`);
}

async function waitFor(path: string): Promise<void> {
  await waitUntil(() => existsSync(path), path);
}

test("competing daemon recoveries cannot delete a newly acquired workspace lock", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "relay-lock-recovery-")));
  const directory = workspaceLockDirectory(root);
  const children: ChildProcess[] = [];
  const exits: Promise<void>[] = [];
  const launch = (id: string) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", contender,
      root, id, new URL("../src/workspace-run-gate.js", import.meta.url).href], { stdio: "pipe" });
    children.push(child);
    let stderr = "";
    child.stderr!.on("data", data => { stderr += data; });
    const exit = new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", code => code === 0 ? resolve() : reject(new Error(`worker ${id}: ${code}: ${stderr}`)));
    });
    // Cleanup also observes failures when an assertion interrupts the test.
    void exit.catch(() => undefined);
    exits.push(exit);
  };
  try {
    mkdirSync(directory, { recursive: true });
    const digest = createHash("sha256").update(join(root, "project")).digest("hex");
    writeFileSync(join(directory, `${digest}.lock`), JSON.stringify({
      pid: 999999999, token: "crashed", createdAt: Date.now(),
    }));
    launch("a");
    await waitFor(join(root, "observed-a"));
    launch("b");
    await waitFor(join(root, "started-b"));
    // Both processes must reach contention before either proceeds. The buggy
    // implementation reaches stale inspection; the fix queues a second unique
    // mutation claim. This handshake does not depend on worker startup speed.
    const claims = join(directory, `${digest}.lock.claims`);
    await waitUntil(() => existsSync(join(root, "observed-b"))
      || (existsSync(claims) && readdirSync(claims).filter(id => !id.startsWith(".")).length === 2),
    "second recovery contender");
    writeFileSync(join(root, "proceed-a"), "");
    await waitFor(join(root, "entered-a"));
    writeFileSync(join(root, "proceed-b"), "");
    await delay(150);
    assert.equal(existsSync(join(root, "entered-b")), false, "second daemon entered the first daemon's workspace");
    writeFileSync(join(root, "release-a"), "");
    await waitFor(join(root, "entered-b"));
    writeFileSync(join(root, "release-b"), "");
    await Promise.all(exits);
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill();
    await Promise.allSettled(exits);
    rmSync(root, { recursive: true, force: true });
    rmSync(directory, { recursive: true, force: true });
  }
});
