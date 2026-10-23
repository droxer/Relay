import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createLocalRuntime } from "../src/local-runtime.js";

/**
 * A fake Pi on an isolated PATH that counts every invocation, so the test can
 * tell a readiness probe that ran from one the cache answered.
 */
function withFakePi(action: (input: { home: string; probes: () => number; setSignedIn: (ok: boolean) => void }) => Promise<void>): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), "relay-local-runtime-"));
  const bin = join(home, "bin");
  const counter = join(home, "probes");
  const state = join(home, "signed-in");
  mkdirSync(bin);
  symlinkSync(process.execPath, join(bin, "node"));
  symlinkSync("/bin/bash", join(bin, "bash"));
  symlinkSync("/usr/bin/grep", join(bin, "grep"));
  writeFileSync(join(bin, "pi"), [
    "#!/bin/sh",
    `case "$1" in --version) echo 0.73.1 ;; --list-models) echo probe >> "${counter}"; [ -f "${state}" ] || { echo "No models available. Use /login" >&2; } ;; esac`,
  ].join("\n"), { mode: 0o755 });
  const previous = process.env;
  process.env = { PATH: bin, RELAY_RUN_AS_CURRENT_USER: "1", RELAY_AGENT_HOME: home, RELAY_AGENT_WORKSPACE: home };
  const setSignedIn = (ok: boolean) => { if (ok) writeFileSync(state, ""); else rmSync(state, { force: true }); };
  setSignedIn(true);
  const probes = () => (existsSync(counter) ? readFileSync(counter, "utf8").split("\n").filter(Boolean).length : 0);
  return action({ home, probes, setSignedIn }).finally(() => {
    process.env = previous;
    rmSync(home, { recursive: true, force: true });
  });
}

test("a local run trusts the readiness discovery recorded instead of re-probing the CLI", async () => {
  await withFakePi(async ({ home, probes, setSignedIn }) => {
    const runtime = createLocalRuntime();
    // Discovery probes and records the pass.
    await runtime.ensureAgentReady("pi");
    assert.equal(probes(), 1);
    // Every run after it starts without the probe.
    const run = await runtime.acquireWorkspace(home);
    await run.ensureAgentReady("pi");
    await run.ensureAgentReady("pi");
    assert.equal(probes(), 1);
    // Discovery always probes afresh, so a runtime that stopped working is reported...
    setSignedIn(false);
    await assert.rejects(runtime.ensureAgentReady("pi"), /No models available/);
    assert.equal(probes(), 2);
    // ...and the next run no longer trusts the stale pass.
    await assert.rejects(run.ensureAgentReady("pi"), /No models available/);
    assert.equal(probes(), 3);
    // Once discovery sees it working again, runs skip the probe again.
    setSignedIn(true);
    await runtime.ensureAgentReady("pi");
    await run.ensureAgentReady("pi");
    assert.equal(probes(), 4);
    run.release();
  });
});

test("a run that never passed discovery probes once, and a failed run forgets the pass", async () => {
  await withFakePi(async ({ home, probes }) => {
    const runtime = createLocalRuntime();
    const run = await runtime.acquireWorkspace(home);
    await run.ensureAgentReady("pi");
    await run.ensureAgentReady("pi");
    assert.equal(probes(), 1);
    run.forgetAgentReady?.("pi");
    await run.ensureAgentReady("pi");
    assert.equal(probes(), 2);
    run.release();
  });
});
