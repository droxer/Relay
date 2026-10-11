import assert from "node:assert/strict";
import test from "node:test";
import { superviseLocalProcess } from "../src/process-supervisor.js";
import { watchExecutionExit } from "../src/execution-capture.js";

const skipOnWindows = { skip: process.platform === "win32" };

test("a stopped local run reports exit once its process group is gone", skipOnWindows, async () => {
  const controller = new AbortController();
  const running = superviseLocalProcess("sh", ["-c", "trap '' TERM; sleep 30"], { signal: controller.signal });
  await new Promise((resolve) => setTimeout(resolve, 100));
  controller.abort();
  const result = await Promise.race([
    running,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), 8000)),
  ]);
  assert.notEqual(result, null, "the supervisor must observe the group's exit after escalating");
});

test("a local run whose group cannot be verified is reported and held until released", skipOnWindows, async (t) => {
  const realKill = process.kill.bind(process);
  // Probing the group (signal 0) fails as it would for a process the daemon may
  // not signal, so exit can never be verified.
  t.mock.method(process, "kill", (pid: number, signal?: string | number) => {
    if (pid < 0 && signal === 0) throw Object.assign(new Error("EPERM"), { code: "EPERM" });
    return realKill(pid, signal as NodeJS.Signals);
  });
  const controller = new AbortController();
  const release = new AbortController();
  let reports = 0;
  watchExecutionExit(controller.signal, { onExitUnconfirmed: () => { reports++; }, release: release.signal });
  let settled = false;
  const running = superviseLocalProcess("sh", ["-c", "sleep 30"], {
    signal: controller.signal, exitUnconfirmedAfterMs: 200,
  }).finally(() => { settled = true; });
  await new Promise((resolve) => setTimeout(resolve, 100));
  controller.abort();
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.equal(settled, false);
  assert.equal(reports, 1);
  release.abort();
  const result = await running;
  assert.match(result.error_message ?? "", /reported gone/);
});

test("a local run tells its watcher which process group it spawned", skipOnWindows, async () => {
  const controller = new AbortController();
  let spawned = 0;
  watchExecutionExit(controller.signal, { onSpawn: (pid) => { spawned = pid; } });
  await superviseLocalProcess("sh", ["-c", "exit 0"], { signal: controller.signal });
  assert.ok(spawned > 0);
});
