import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

test("standalone computer bundle includes all direct-execution dependencies", () => {
  const directory = mkdtempSync(join(tmpdir(), "relay-bundle-test-"));
  try {
    execFileSync("tar", ["-xzf", resolve("backend/relay/computer/daemon.tar.gz"), "-C", directory]);
    const output = execFileSync(process.execPath, [join(directory, "node_modules/relay-daemon/dist/cli.js"), "--help"], {
      cwd: directory, env: { PATH: process.env.PATH, HOME: directory }, encoding: "utf8",
    });
    assert.match(output, /relay-daemon/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
