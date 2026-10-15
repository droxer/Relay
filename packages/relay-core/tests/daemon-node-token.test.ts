import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  daemonNodeTokenPath,
  ensureDaemonNodeToken,
  writeDaemonNodeToken,
} from "../src/daemon-node-token.js";

test("an explicit daemon token replaces a stale persisted token", (t) => {
  const workspacePath = mkdtempSync(join(tmpdir(), "relay-daemon-token-"));
  const credentialDirectory = mkdtempSync(join(tmpdir(), "relay-daemon-private-"));
  t.after(() => {
    rmSync(workspacePath, { recursive: true, force: true });
    rmSync(credentialDirectory, { recursive: true, force: true });
  });

  writeDaemonNodeToken(credentialDirectory, "user-1", "stale-token");

  const resolution = ensureDaemonNodeToken({
    credentialDirectory,
    userId: "user-1",
    token: "current-token",
  });

  assert.equal(resolution.source, "explicit");
  assert.equal(
    readFileSync(daemonNodeTokenPath(credentialDirectory, "user-1"), "utf8").trim(),
    "current-token",
  );
  assert.equal(existsSync(join(workspacePath, ".relay")), false);
});
