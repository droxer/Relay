import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { test } from "node:test";

for (const installFails of [false, true]) {
  test(`automatic computer rebuild ${installFails ? "stops after a failed install" : "installs dependencies before compiling"}`, {
    skip: process.platform === "win32" && "The Makefile is a Unix development entrypoint",
  }, () => {
    const directory = mkdtempSync(join(tmpdir(), "relay-computer-build-"));
    const log = join(directory, "npm.log");
    try {
      writeFileSync(join(directory, "npm"), `#!/bin/sh
echo "$*" >> "$RELAY_BUILD_TEST_LOG"
if [ "$1" = install ]; then exit ${installFails ? 1 : 0}; fi
`, { mode: 0o755 });
      execFileSync("make", [
        "-f", resolve("Makefile"),
        "COMPUTER_BUNDLE=bundle.tar.gz", "COMPUTER_BUNDLE_SOURCES=",
        "bundle.tar.gz",
      ], {
        cwd: directory,
        env: { ...process.env, PATH: `${directory}${delimiter}${process.env.PATH}`, RELAY_BUILD_TEST_LOG: log },
        stdio: "pipe",
      });
      assert.deepEqual(readFileSync(log, "utf8").trim().split("\n"), installFails
        ? ["install -w relay-daemon"]
        : ["install -w relay-daemon", "run build:computer"]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
