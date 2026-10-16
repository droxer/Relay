import assert from "node:assert/strict";
import { test } from "node:test";
import { appendFileSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync, writeSync, closeSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rotateServiceLog } from "../src/service-log.js";
import { syncDirectory } from "../src/sync-directory.js";

test("service.log rotates to one previous generation and keeps taking appends", () => {
  const root = mkdtempSync(join(tmpdir(), "relay-service-log-"));
  try {
    const file = join(root, "service.log");
    writeFileSync(file, "old output\n");
    // The writer (launchd, the Windows host) keeps its append descriptor open.
    const writer = openSync(file, "a");
    assert.equal(rotateServiceLog(file, 1_000), false);
    appendFileSync(file, "x".repeat(2_000));
    assert.equal(rotateServiceLog(file, 1_000), true);
    writeSync(writer, "after rotation\n");
    closeSync(writer);
    assert.equal(readFileSync(file, "utf8"), "after rotation\n");
    assert.match(readFileSync(`${file}.1`, "utf8"), /^old output\nx+$/);
    assert.equal(rotateServiceLog(join(root, "missing.log"), 1), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("directory sync is skipped on Windows, which cannot fsync a directory", () => {
  // Would throw ENOENT if it tried to open the directory.
  assert.doesNotThrow(() => syncDirectory(join(tmpdir(), "relay-no-such-directory"), "win32"));
  assert.throws(() => syncDirectory(join(tmpdir(), "relay-no-such-directory"), "linux"), /ENOENT/);
});
