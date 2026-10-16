import assert from "node:assert/strict";
import { test } from "node:test";
import { parseWindowsProcesses, taskkillArguments, windowsProcessTree } from "../src/windows-process-tree.js";
import { windowsExitProven } from "../src/exit-proof.js";
import { parsePidFile } from "../src/windows-service-host.js";

const T = 1_760_000_000_000;

test("Windows process lines parse into pid, parent and creation time", () => {
  assert.deepEqual(parseWindowsProcesses(`4 0 ${T}\r\n\r\nnoise\r\n900 4 ${T + 5}\r\n`), [
    { pid: 4, parentPid: 0, createdAt: T },
    { pid: 900, parentPid: 4, createdAt: T + 5 },
  ]);
});

test("a run's tree keeps the orphans a finished bash left behind", () => {
  // bash (100) has exited; its agent (200) and the agent's tool (300) still name it as parent.
  const processes = [
    { pid: 200, parentPid: 100, createdAt: T + 1_000 },
    { pid: 300, parentPid: 200, createdAt: T + 2_000 },
    { pid: 400, parentPid: 1, createdAt: T + 3_000 },
  ];
  assert.deepEqual(windowsProcessTree(processes, 100, T), [200, 300]);
});

test("a live root is part of its own tree", () => {
  const processes = [{ pid: 100, parentPid: 8, createdAt: T + 50 }, { pid: 200, parentPid: 100, createdAt: T + 60 }];
  assert.deepEqual(windowsProcessTree(processes, 100, T), [100, 200]);
});

test("a recycled pid is not mistaken for the run or its children", () => {
  const processes = [
    // pid 100 now belongs to a process started an hour later, with its own child.
    { pid: 100, parentPid: 8, createdAt: T + 3_600_000 },
    { pid: 500, parentPid: 100, createdAt: T + 3_600_100 },
    // created before the run's root: it cannot descend from it.
    { pid: 600, parentPid: 100, createdAt: T - 60_000 },
  ];
  assert.deepEqual(windowsProcessTree(processes, 100, T), [500]);
  assert.deepEqual(windowsProcessTree([{ pid: 600, parentPid: 100, createdAt: T - 60_000 }], 100, T), []);
});

test("taskkill ends every member in one call", () => {
  assert.deepEqual(taskkillArguments([1, 2]), ["/F", "/PID", "1", "/PID", "2"]);
});

test("a Windows run is proven over only when its whole tree is gone", () => {
  const evidence = { processGroup: 100, spawnedAt: T, bootAt: 5_000 };
  assert.equal(windowsExitProven(evidence, [], 5_000), true);
  assert.equal(windowsExitProven(evidence, [{ pid: 200, parentPid: 100, createdAt: T + 1 }], 5_000), false);
  // No process list, or no spawn time to tell pid reuse apart, proves nothing.
  assert.equal(windowsExitProven(evidence, undefined, 5_000), false);
  assert.equal(windowsExitProven({ processGroup: 100, bootAt: 5_000 }, [], 5_000), false);
  // A reboot ends everything.
  assert.equal(windowsExitProven(evidence, undefined, 5_000 + 10 * 60_000), true);
});

test("the service host pid file carries the creation time, and older ones still parse", () => {
  assert.deepEqual(parsePidFile(`4242 ${T}\n`), { pid: 4242, createdAt: T });
  assert.deepEqual(parsePidFile("4242"), { pid: 4242 });
  assert.equal(parsePidFile(""), undefined);
});
