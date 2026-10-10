import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadManagedEnrollment, saveManagedEnrollment } from "../src/managed-enrollment.js";

test("managed enrollment is saved privately and atomically outside the workspace", () => {
  const root = mkdtempSync(join(tmpdir(), "relay-enrollment-"));
  try {
    const path = join(root, "identity.json");
    assert.equal(loadManagedEnrollment(path), undefined);
    const enrollment = { sandboxId: "sandbox", token: "runtime-token", employeeId: "alice", sandboxMode: "boxlite" as const };
    saveManagedEnrollment(path, enrollment);
    assert.deepEqual(loadManagedEnrollment(path), enrollment);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    saveManagedEnrollment(path, { ...enrollment, token: "replacement" });
    assert.equal(loadManagedEnrollment(path)?.token, "replacement");
    assert.deepEqual(readdirSync(root), ["identity.json"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const data of ["not json", JSON.stringify({ sandboxId: "sandbox" }), JSON.stringify({ sandboxId: "", token: "token" })]) {
  test(`damaged enrollment state fails closed: ${data}`, () => {
    const root = mkdtempSync(join(tmpdir(), "relay-enrollment-"));
    try {
      const path = join(root, "identity.json");
      writeFileSync(path, data);
      assert.throws(() => loadManagedEnrollment(path));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

test("enrollment read errors are surfaced rather than silently enrolling again", () => {
  const root = mkdtempSync(join(tmpdir(), "relay-enrollment-"));
  try { assert.throws(() => loadManagedEnrollment(root)); }
  finally { rmSync(root, { recursive: true, force: true }); }
});
