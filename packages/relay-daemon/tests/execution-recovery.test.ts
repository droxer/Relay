import assert from "node:assert/strict";
import test from "node:test";
import { collectExecution } from "../src/box.js";

const tick = () => new Promise<void>(resolve => setTimeout(resolve, 10));
const closed = async () => ({ next: async () => null });

test("exit is observed while an inherited output stream remains open", async () => {
  let waited = false;
  let release!: (value: null) => void;
  const stream = new Promise<null>(resolve => { release = resolve; });
  const pending = collectExecution({
    stdout: async () => ({ next: async () => stream }), stderr: closed,
    wait: async () => { waited = true; return { exitCode: 0 }; },
  });
  await tick();
  const observedBeforeEof = waited;
  release(null);
  await pending;
  assert.equal(observedBeforeEof, true);
});

test("cancellation retries a rejected kill and retains execution until exit", async () => {
  const controller = new AbortController();
  let kills = 0;
  let release!: (value: { exitCode: number }) => void;
  const exit = new Promise<{ exitCode: number }>(resolve => { release = resolve; });
  const warnings: string[] = [];
  let settled = false;
  const pending = collectExecution({stdout: closed, stderr: closed, wait: async () => exit,
    kill: async () => { kills++; if (kills === 1) throw new Error("transport unavailable"); },
  }, false, undefined, undefined, undefined, controller.signal,
  { retryMs: 5, graceMs: 5, warn: message => warnings.push(message) }).finally(() => { settled = true; });
  controller.abort();
  await new Promise(resolve => setTimeout(resolve, 30));
  const retained = !settled;
  release({exitCode: 137});
  const result = await pending;
  assert.equal(retained, true);
  assert.ok(kills >= 2);
  assert.ok(warnings.some(message => message.includes("transport unavailable")));
  assert.equal(result.error_message, "Execution cancelled.");
});

test("cancellation escalates from TERM to KILL and stops retries after confirmed exit", async () => {
  const controller = new AbortController();
  const signals: number[] = [];
  let release!: (value: {exitCode: number}) => void;
  const exit = new Promise<{exitCode: number}>(resolve => { release = resolve; });
  const pending = collectExecution({stdout: closed, stderr: closed, wait: async () => exit,
    signal: async (signal: number) => { signals.push(signal); },
    kill: async () => { signals.push(9); release({exitCode: 137}); },
  }, false, undefined, undefined, undefined, controller.signal, { retryMs: 5, graceMs: 5 });
  controller.abort();
  await pending;
  const count = signals.length;
  await tick();
  assert.equal(signals[0], 15);
  assert.ok(signals.includes(9));
  assert.equal(signals.length, count);
});


test("verified exit permits bounded stream draining and preserves captured output", async () => {
  const warnings: string[] = [];
  let first = true;
  const result = await collectExecution({
    stdout: async () => ({next: async () => { if (first) {first = false; return "saved output";} return new Promise(() => {}); }}),
    stderr: closed, wait: async () => ({exitCode: 0}),
  }, false, undefined, undefined, undefined, undefined, {streamDrainMs: 5, warn: message => warnings.push(message)});
  assert.equal(result.stdout, "saved output");
  assert.equal(result.exit_code, 0);
  assert.match(warnings[0]!, /exit confirmed.*drain timed out/);
});

test("failed exit queries retry without fabricating terminal evidence", async () => {
  let waits = 0;
  let kills = 0;
  const warnings: string[] = [];
  const result = await collectExecution({
    stdout: closed, stderr: closed, kill: async () => { kills++; },
    wait: async () => { if (++waits < 3) throw new Error("guest unavailable"); return {exitCode: 1}; },
  }, false, undefined, undefined, undefined, undefined, {retryMs: 5, warn: message => warnings.push(message)});
  assert.equal(waits, 3);
  assert.ok(kills > 0);
  assert.equal(result.exit_code, 1);
  assert.ok(warnings.some(message => message.includes("Cannot confirm")));
});

test("cancellation watchdog warns without completing an unconfirmed execution", async () => {
  const controller = new AbortController();
  const warnings: string[] = [];
  let finish!: (value: {exitCode: number}) => void;
  const exit = new Promise<{exitCode: number}>(resolve => { finish = resolve; });
  let settled = false;
  const pending = collectExecution({stdout: closed, stderr: closed, wait: async () => exit, kill: async () => {}},
    false, undefined, undefined, undefined, controller.signal, {graceMs: 5,retryMs: 5,warn: message => warnings.push(message)})
    .finally(()=>{settled = true;});
  controller.abort();
  await new Promise(resolve=>setTimeout(resolve,30));
  assert.equal(settled,false);
  assert.ok(warnings.some(message=>message.includes("Cancellation overdue")));
  finish({exitCode: 137});
  await pending;
});
