import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { watchExecutionExit } from "../src/execution-capture.js";
import { ExecutionJournal } from "../src/execution-journal.js";
import { cleanupLinuxRunCgroup, createLinuxRunCgroup, linuxRunInvocation, type LinuxRunCgroup } from "../src/linux-run-cgroup.js";
import { superviseLocalProcess } from "../src/process-supervisor.js";

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await sleep(20);
  }
  assert.fail("Timed out waiting for a Linux run to change state.");
}

function populated(group: LinuxRunCgroup): boolean {
  return /^populated 1$/m.test(readFileSync(join(group.parent, group.name, "cgroup.events"), "utf8"));
}

test("Linux recovery kills only the journaled run, including children in another process group", {
  skip: process.platform !== "linux",
  timeout: 10_000,
}, async t => {
  const probe = createLinuxRunCgroup();
  if (!probe && !process.env.RELAY_TEST_REQUIRE_CGROUP) return t.skip("requires a delegated cgroup v2 with cgroup.kill");
  assert.ok(probe);
  assert.ok(cleanupLinuxRunCgroup(probe, false));

  const root = mkdtempSync(join(tmpdir(), "relay-run-cgroup-"));
  const journal = new ExecutionJournal(root);
  const target = { id: "target", runId: "target-run", sessionId: "target-thread", leaseId: "target-lease", agent: "codex" as const };
  const other = { id: "other", runId: "other-run", sessionId: "other-thread", leaseId: "other-lease", agent: "codex" as const };
  journal.record(target);
  journal.record(other);

  // This child plays the Daemon. The CLI leaves an orphan in a new session
  // with closed stdio and no live process-group leader after the Daemon dies.
  const cli = `
    const { spawn } = require("node:child_process");
    const { appendFileSync, writeFileSync } = require("node:fs");
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
    child.unref();
    const ticks = process.argv[1] + ".ticks";
    writeFileSync(ticks, "");
    writeFileSync(process.argv[1], String(child.pid));
    setInterval(() => appendFileSync(ticks, "."), 20);
  `;
  const daemon = spawn(process.execPath, ["--input-type=module", "-e", `
    import { ExecutionJournal } from ${JSON.stringify(new URL("../src/execution-journal.js", import.meta.url).href)};
    import { superviseLocalProcess } from ${JSON.stringify(new URL("../src/process-supervisor.js", import.meta.url).href)};
    import { watchExecutionExit } from ${JSON.stringify(new URL("../src/execution-capture.js", import.meta.url).href)};
    const journal = new ExecutionJournal(process.argv[1]);
    await Promise.all(["target", "other"].map(id => {
      const { signal } = new AbortController();
      watchExecutionExit(signal, { onCgroup: cgroup => journal.attach(id, { cgroup }) });
      return superviseLocalProcess(process.execPath, ["-e", ${JSON.stringify(cli)}, process.argv[1] + "/" + id], { signal });
    }));
  `, root], { stdio: ["ignore", "ignore", "inherit"] });
  const daemonExit = once(daemon, "exit");
  t.after(async () => {
    daemon.kill("SIGKILL");
    await daemonExit;
    for (const { cgroup } of journal.pending()) {
      if (cgroup) await waitUntil(() => cleanupLinuxRunCgroup(cgroup, true));
    }
    rmSync(root, { recursive: true, force: true });
  });
  await waitUntil(() => existsSync(join(root, "target")) && existsSync(join(root, "other")));
  assert.equal(journal.requestStop({
    ...target, id: "request", commandId: target.id, type: "run.cancel", targetLeaseId: target.leaseId, reason: "Stop requested",
  }), true);
  daemon.kill("SIGKILL");
  await daemonExit;

  const records = new ExecutionJournal(root).pending();
  const cancelled = records.find(record => record.id === target.id);
  const running = records.find(record => record.id === other.id);
  assert.ok(cancelled?.stopRequested && cancelled.cgroup);
  assert.ok(running?.cgroup && !running.stopRequested);
  const targetGroup = cancelled.cgroup;
  const otherGroup = running.cgroup;
  const targetPid = readFileSync(join(root, "target"), "utf8");
  // End the original CLI root to exercise recovery using just the descendant.
  const members = readFileSync(join(targetGroup.parent, targetGroup.name, "cgroup.procs"), "utf8").trim().split("\n");
  assert.equal(members.length, 2);
  const cliPid = members.find(pid => pid !== targetPid);
  assert.ok(cliPid);
  process.kill(Number(cliPid), "SIGKILL");
  assert.equal(populated(targetGroup), true);
  assert.equal(cleanupLinuxRunCgroup({ ...targetGroup, inode: otherGroup.inode }, true), false);
  assert.equal(populated(targetGroup), true);
  assert.equal(cleanupLinuxRunCgroup(otherGroup, false), false);
  assert.equal(cleanupLinuxRunCgroup(targetGroup, true), false);
  await waitUntil(() => cleanupLinuxRunCgroup(targetGroup, true));
  assert.equal(populated(otherGroup), true);
  const heartbeat = join(root, "other.ticks");
  const size = readFileSync(heartbeat).length;
  await waitUntil(() => readFileSync(heartbeat).length > size);
});

test("Linux local cancellation waits for contained descendants and still captures output", {
  skip: process.platform !== "linux",
  timeout: 5_000,
}, async t => {
  const probe = createLinuxRunCgroup();
  if (!probe && !process.env.RELAY_TEST_REQUIRE_CGROUP) return t.skip("requires a delegated cgroup v2 with cgroup.kill");
  assert.ok(probe);
  assert.ok(cleanupLinuxRunCgroup(probe, false));
  const controller = new AbortController();
  const release = new AbortController();
  let group: LinuxRunCgroup | undefined;
  t.after(async () => {
    release.abort();
    if (group) await waitUntil(() => cleanupLinuxRunCgroup(group!, true));
  });
  watchExecutionExit(controller.signal, {
    stopGraceMs: 20,
    release: release.signal,
    onCgroup: cgroup => { group = cgroup; },
  });
  const result = await superviseLocalProcess(process.execPath, ["-e", `
    const child = require("node:child_process").spawn(process.execPath,
      ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
    child.unref();
    console.log("descendant ready");
    setInterval(() => {}, 1000);
  `], {
    signal: controller.signal,
    sink: () => controller.abort(),
  });
  assert.ok(group);
  assert.match(result.stdout, /descendant ready/);
  assert.equal(existsSync(join(group.parent, group.name)), false);
});

test("a removed Linux cgroup cannot be joined by a late launcher", {
  skip: process.platform !== "linux",
  timeout: 5000,
}, async t => {
  const group = createLinuxRunCgroup();
  if (!group && !process.env.RELAY_TEST_REQUIRE_CGROUP) return t.skip("requires a delegated cgroup v2 with cgroup.kill");
  assert.ok(group);
  assert.ok(cleanupLinuxRunCgroup(group, false));
  const launch = linuxRunInvocation(group, process.execPath, ["-e", "process.exit(0)"]);
  const child = spawn(launch.command, launch.args);
  const [code] = await once(child, "close");
  assert.equal(code, 125);
});
