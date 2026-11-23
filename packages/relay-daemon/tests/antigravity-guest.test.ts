import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { shellQuote } from "relay-core";
import { localProcessExecStream } from "../src/local-runtime.js";
import { stageAntigravityAcp } from "../src/permission-adapters/antigravity-guest.js";

test("the staged Antigravity launcher survives a failed resume and is removed after the fresh attempt", {
  skip: process.platform === "win32",
}, async () => {
  const root = mkdtempSync(join(tmpdir(), "relay-agy-guest-test-"));
  const previous = process.env;
  process.env = { ...previous, RELAY_RUN_AS_CURRENT_USER: "1", RELAY_AGENT_HOME: root, PATH: `${root}:${previous.PATH}` };
  try {
    const fixture = resolve("packages/relay-daemon/tests/fixtures/agy-e2e.mjs");
    writeFileSync(join(root, "agy"), `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(fixture)} "$@"\n`, { mode: 0o700 });
    writeFileSync(join(root, ".discard-conversation"), "");
    const { launch, dispose } = await stageAntigravityAcp({ execStream: localProcessExecStream }, root);
    const args = [...launch.args, "--cwd", root, "--model", "gemini-test", "--prompt", "Say hello."];
    try {
      const missing = await localProcessExecStream(launch.command, [...args, "--resume", "missing-conversation"], { cwd: root });
      assert.notEqual(missing.exit_code, 0);
      assert.match(missing.stderr, /Conversation not found/);
      const fresh = await localProcessExecStream(launch.command, args, { cwd: root });
      assert.equal(fresh.exit_code, 0, fresh.stderr);
      assert.match(fresh.stdout, /"session_id":/);
      assert.match(fresh.stdout, /RELAY_AGY_/);
    } finally {
      await dispose();
    }
    assert.equal(existsSync(launch.args[0]), false);
  } finally {
    process.env = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
