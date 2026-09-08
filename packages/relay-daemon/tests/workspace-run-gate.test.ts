import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  WorkspaceRunGate,
  workspaceLockDirectory,
} from "../src/workspace-run-gate.js";

test("project runs sharing a physical workspace execute one at a time", async () => {
  const gate = new WorkspaceRunGate();
  const order: string[] = [];
  let releaseFirst!: () => void;
  const firstBlocked = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });

  const first = gate.run("/workspace/projects/one", undefined, async () => {
    order.push("first:start");
    await firstBlocked;
    order.push("first:end");
  });
  const second = gate.run("/workspace/projects/one", undefined, async () => {
    order.push("second:start");
    order.push("second:end");
  });

  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ["first:start"]);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(order, ["first:start", "first:end", "second:start", "second:end"]);
});

test("different physical project workspaces may execute concurrently", async () => {
  const gate = new WorkspaceRunGate();
  let active = 0;
  let peak = 0;
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const run = (key: string) => gate.run(key, undefined, async () => {
    active += 1;
    peak = Math.max(peak, active);
    await blocked;
    active -= 1;
  });

  const first = run("/workspace/projects/one");
  const second = run("/workspace/projects/two");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(peak, 2);
  release();
  await Promise.all([first, second]);
});

test("a cancelled queued run never enters the project workspace", async () => {
  const gate = new WorkspaceRunGate();
  let releaseFirst!: () => void;
  const firstBlocked = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const first = gate.run("shared", undefined, () => firstBlocked);
  const controller = new AbortController();
  let entered = false;
  const queued = gate.run("shared", controller.signal, async () => {
    entered = true;
  });
  controller.abort("cancelled while queued");

  await assert.rejects(queued, /cancelled while queued/);
  releaseFirst();
  await first;
  assert.equal(entered, false);
});

test("independent daemon gates share a filesystem project lock", async () => {
  const root = mkdtempSync(join(tmpdir(), "relay-workspace-gate-"));
  const rootAlias = `${root}-alias`;
  symlinkSync(root, rootAlias, "dir");
  const lockDirectory = workspaceLockDirectory(root);
  try {
    const firstGate = new WorkspaceRunGate(root);
    const replacementGate = new WorkspaceRunGate(rootAlias);
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = firstGate.run(join(root, "projects", "one"), undefined, async () => {
      order.push("first:start");
      await firstBlocked;
      order.push("first:end");
    });
    const replacement = replacementGate.run(
      join(rootAlias, "projects", "one"),
      undefined,
      async () => {
        order.push("replacement:start");
        order.push("replacement:end");
      },
    );

    await new Promise<void>((resolve) => setTimeout(resolve, 40));
    assert.deepEqual(order, ["first:start"]);
    releaseFirst();
    await Promise.all([first, replacement]);
    assert.deepEqual(order, [
      "first:start",
      "first:end",
      "replacement:start",
      "replacement:end",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
    unlinkSync(rootAlias);
    rmSync(lockDirectory, { recursive: true, force: true });
  }
});

test("a replacement daemon reclaims a crashed owner's project lock", async () => {
  const root = mkdtempSync(join(tmpdir(), "relay-workspace-gate-"));
  const lockDirectory = workspaceLockDirectory(root);
  try {
    const projectPath = join(root, "projects", "one");
    mkdirSync(projectPath, { recursive: true });
    const key = realpathSync(projectPath);
    mkdirSync(lockDirectory, { recursive: true });
    const digest = createHash("sha256").update(key).digest("hex");
    writeFileSync(
      join(lockDirectory, `${digest}.lock`),
      JSON.stringify({ pid: 999_999_999, token: "crashed", createdAt: Date.now() }),
    );
    const replacementGate = new WorkspaceRunGate(root);
    let entered = false;

    await replacementGate.run(key, undefined, async () => {
      entered = true;
    });

    assert.equal(entered, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(lockDirectory, { recursive: true, force: true });
  }
});

test("the daemon tightens a pre-existing workspace lock directory", async () => {
  const root = mkdtempSync(join(tmpdir(), "relay-workspace-gate-"));
  const lockDirectory = workspaceLockDirectory(root);
  try {
    mkdirSync(lockDirectory, { recursive: true });
    chmodSync(lockDirectory, 0o777);
    const gate = new WorkspaceRunGate(root);

    await gate.run(join(root, "projects", "one"), undefined, async () => undefined);

    assert.equal(statSync(lockDirectory).mode & 0o077, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(lockDirectory, { recursive: true, force: true });
  }
});

test("waiting runs report the blocking thread and clear their wait before execution", async () => {
  const gate = new WorkspaceRunGate();
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const states: Array<string | null | undefined> = [];
  const first = gate.run("shared", undefined, () => blocked, { sessionId: "first-thread" });
  await new Promise<void>(resolve => setImmediate(resolve));
  const second = gate.run("shared", undefined, async () => {
    assert.equal(states.at(-1), null);
  }, { sessionId: "second-thread", onWaiting: async owner => { states.push(owner); } });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(states[0], "first-thread");
  release();
  await Promise.all([first, second]);
  assert.deepEqual(states, ["first-thread", null]);
});

test("a queued observer failure cannot fail the run holding the workspace", async () => {
  const gate = new WorkspaceRunGate();
  let executed = false;
  const first = gate.run("shared", undefined, async () => { executed = true; }, { sessionId: "first" });
  const second = gate.run("shared", undefined, async () => {}, {
    sessionId: "second",
    onWaiting: async owner => { if (owner === "first") throw new Error("queued notification cancelled"); },
  });
  await first;
  await second;
  assert.equal(executed, true);
});
