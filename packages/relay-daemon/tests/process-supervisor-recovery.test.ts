import assert from "node:assert/strict";
import cp from "node:child_process";
import { once } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { superviseLocalProcess } from "../src/process-supervisor.js";
import { watchExecutionExit } from "../src/execution-capture.js";

for (const recover of [false, true]) {
  test(`a failed kill holds execution until ${recover ? "permissions recover" : "operator release"}`, { skip: process.platform === "win32" }, async () => {
    const originalSpawn = cp.spawn;
    const realKill = process.kill.bind(process);
    let child: cp.ChildProcess | undefined;
    cp.spawn = ((...args: Parameters<typeof cp.spawn>) => {
      child = originalSpawn(...args);
      return child;
    }) as typeof cp.spawn;
    syncBuiltinESMExports();
    const stop = new AbortController(), release = new AbortController();
    let reports = 0, settled = false;
    watchExecutionExit(stop.signal, { release: release.signal, onExitUnconfirmed: () => reports++, stopGraceMs: 20 });
    const running = superviseLocalProcess(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      signal: stop.signal, exitUnconfirmedAfterMs: 40,
    }).finally(() => { settled = true; });
    const spawned = child!;
    let handle: { kill(signal: number): number } | undefined;
    let originalHandleKill: ((signal: number) => number) | undefined;
    try {
      await once(spawned, "spawn");
      handle = (spawned as unknown as { _handle: typeof handle })._handle;
      assert.ok(handle);
      originalHandleKill = handle.kill;
      handle.kill = () => -1; // libuv UV_EPERM: the real ChildProcess emits an error.
      process.kill = ((pid: number, signal?: string | number) => {
        if (pid === -spawned.pid! && signal !== 0) throw Object.assign(new Error("EPERM"), { code: "EPERM" });
        return realKill(pid, signal as NodeJS.Signals);
      }) as typeof process.kill;
      stop.abort();
      await delay(120);
      realKill(-spawned.pid!, 0);
      assert.equal(settled, false, "a failed signal is not exit evidence");
      assert.equal(reports, 1);
      if (recover) {
        process.kill = realKill;
        handle.kill = originalHandleKill;
        const result = await Promise.race([running, delay(2500).then(() => null)]);
        assert.ok(result, "termination must retry after permissions recover");
        assert.doesNotMatch(result.error_message ?? "", /reported gone/);
      } else {
        release.abort();
        assert.match((await running).error_message ?? "", /reported gone/);
      }
    } finally {
      process.kill = realKill; cp.spawn = originalSpawn; syncBuiltinESMExports();
      if (handle && originalHandleKill) handle.kill = originalHandleKill;
      release.abort();
      // Operator release deliberately unrefs the child. The test still owns
      // cleanup, so keep its handle alive until the exit event is observed.
      spawned.ref();
      const closed = spawned.exitCode === null && spawned.signalCode === null ? once(spawned, "close") : undefined;
      try { realKill(-spawned.pid!, "SIGKILL"); } catch { /* already gone */ }
      await running;
      await closed;
    }
  });
}

for (const recover of [false, true]) {
  test(`Windows enumeration failure retains execution until ${recover ? "verified recovery" : "operator release"}`, async () => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    const realExecFile = cp.execFile;
    const realKill = process.kill.bind(process);
    const stop = new AbortController(), release = new AbortController();
    let pid = 0, reports = 0, settled = false, listAvailable = false;
    watchExecutionExit(stop.signal, { release: release.signal, onExitUnconfirmed: () => reports++ });
    let running: ReturnType<typeof superviseLocalProcess> | undefined;
    try {
      Object.defineProperty(process, "platform", { ...platform, value: "win32" });
      cp.execFile = ((_cmd: unknown, _args: unknown, _options: unknown, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
        queueMicrotask(() => callback(listAvailable ? null : new Error("enumeration unavailable"), "", ""));
      }) as unknown as typeof cp.execFile;
      syncBuiltinESMExports();
      const script = "const {spawn}=require('node:child_process'); const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});console.log(c.pid);c.unref();";
      running = superviseLocalProcess(process.execPath, ["-e", script], {
        signal: stop.signal, exitUnconfirmedAfterMs: 40,
        sink: text => { pid = Number(text.trim()) || pid; },
      }).finally(() => { settled = true; });
      const deadline = Date.now() + 2000;
      while (!pid && Date.now() < deadline) await delay(10);
      assert.ok(pid);
      await delay(1150);
      realKill(pid, 0);
      assert.equal(settled, false, "pipe EOF cannot prove descendant exit when enumeration fails");
      assert.equal(reports, 1);
      if (recover) {
        realKill(pid, "SIGKILL"); pid = 0; listAvailable = true;
        assert.equal((await running).exit_code, 0);
      } else {
        release.abort();
        assert.match((await running).error_message ?? "", /reported gone/);
      }
    } finally {
      release.abort();
      if (running) await running;
      Object.defineProperty(process, "platform", platform);
      cp.execFile = realExecFile; syncBuiltinESMExports();
      if (pid) { try { realKill(pid, "SIGKILL"); } catch { /* already gone */ } }
    }
  });
}

test("a process that cannot spawn still reports failure without waiting for reconciliation", async () => {
  const result = await superviseLocalProcess("/relay-nonexistent-executable-for-recovery-test");
  assert.equal(result.exit_code, -1);
  assert.match(result.error_message ?? "", /ENOENT/);
});
