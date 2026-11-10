import assert from "node:assert/strict";
import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PROJECT_CONTEXT_RELATIVE_PATH, syncProjectContext } from "../src/project-context.js";

test("a project run mirrors its brief into the workspace", () => {
  const workspace = mkdtempSync(join(tmpdir(), "relay-project-context-"));
  syncProjectContext(workspace, "project", "Project: Website launch\nGoal: Ship it");
  const written = readFileSync(join(workspace, PROJECT_CONTEXT_RELATIVE_PATH), "utf8");
  assert.match(written, /Edit the project, not this file/);
  assert.match(written, /Project: Website launch\nGoal: Ship it\n$/);
});

test("a run without a brief removes a stale mirror", () => {
  const workspace = mkdtempSync(join(tmpdir(), "relay-project-context-"));
  syncProjectContext(workspace, "project", "Project: Old");
  syncProjectContext(workspace, "project", undefined);
  assert.equal(existsSync(join(workspace, PROJECT_CONTEXT_RELATIVE_PATH)), false);
});

test("non-project layouts are left untouched", () => {
  const workspace = mkdtempSync(join(tmpdir(), "relay-project-context-"));
  syncProjectContext(workspace, "thread", "Project: Website launch");
  assert.equal(existsSync(join(workspace, PROJECT_CONTEXT_RELATIVE_PATH)), false);
});

test("a setup round's proposal is reported once and then removed", async () => {
  const { consumeProjectSetup, PROJECT_SETUP_RELATIVE_PATH } = await import("../src/project-setup.js");
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const workspace = mkdtempSync(join(tmpdir(), "relay-project-setup-"));
  mkdirSync(join(workspace, ".relay"), { recursive: true });
  writeFileSync(join(workspace, PROJECT_SETUP_RELATIVE_PATH), JSON.stringify({ name: "Launch", members: [] }));
  assert.deepEqual(consumeProjectSetup(workspace, PROJECT_SETUP_RELATIVE_PATH), { name: "Launch", members: [] });
  assert.equal(consumeProjectSetup(workspace, PROJECT_SETUP_RELATIVE_PATH), undefined);
  writeFileSync(join(workspace, PROJECT_SETUP_RELATIVE_PATH), "[1, 2]");
  assert.equal(consumeProjectSetup(workspace, PROJECT_SETUP_RELATIVE_PATH), undefined, "a non-object is not a proposal");
  assert.equal(existsSync(join(workspace, PROJECT_SETUP_RELATIVE_PATH)), false);
});

test("setup attempts consume only their own proposal in a shared workspace", async () => {
  const { consumeProjectSetup } = await import("../src/project-setup.js");
  const { mkdirSync, writeFileSync, rmSync } = await import("node:fs");
  const workspace = mkdtempSync(join(tmpdir(), "relay-project-setup-isolation-"));
  try {
    mkdirSync(join(workspace, ".relay"));
    writeFileSync(join(workspace, ".relay/project-setup-first.json"), JSON.stringify({ goal: "First" }));
    writeFileSync(join(workspace, ".relay/project-setup-second.json"), JSON.stringify({ goal: "Second" }));
    assert.equal(consumeProjectSetup(workspace, undefined), undefined);
    assert.deepEqual(consumeProjectSetup(workspace, ".relay/project-setup-first.json"), { goal: "First" });
    assert.equal(consumeProjectSetup(workspace, ".relay/project-setup-first.json"), undefined);
    assert.deepEqual(consumeProjectSetup(workspace, ".relay/project-setup-second.json"), { goal: "Second" });
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("setup consumption rejects escaping paths and removes malformed or oversized proposals", async () => {
  const { consumeProjectSetup, PROJECT_SETUP_RELATIVE_PATH } = await import("../src/project-setup.js");
  const { mkdirSync, writeFileSync, rmSync } = await import("node:fs");
  const workspace = mkdtempSync(join(tmpdir(), "relay-project-setup-invalid-"));
  const file = join(workspace, PROJECT_SETUP_RELATIVE_PATH);
  try {
    mkdirSync(join(workspace, ".relay"));
    writeFileSync(file, JSON.stringify({ goal: "Legacy proposal" }));
    assert.equal(consumeProjectSetup(workspace, undefined), undefined);
    assert.equal(consumeProjectSetup(workspace, ".relay/../project-setup.json"), undefined);
    assert.equal(consumeProjectSetup(workspace, file), undefined);
    assert.equal(existsSync(file), true);
    for (const raw of ["not JSON", "null", "x".repeat(256 * 1024 + 1)]) {
      writeFileSync(file, raw);
      assert.equal(consumeProjectSetup(workspace, PROJECT_SETUP_RELATIVE_PATH), undefined);
      assert.equal(existsSync(file), false);
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

for (const kind of ["symlink", "hardlink"] as const) {
  test(`project brief replacement does not write through a ${kind}`, (t) => {
    const root = mkdtempSync(join(tmpdir(), "relay-project-brief-link-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const workspace = join(root, "workspace");
    mkdirSync(join(workspace, ".relay"), { recursive: true });
    const external = join(root, "host-file");
    writeFileSync(external, "preserve host contents");
    const mirror = join(workspace, PROJECT_CONTEXT_RELATIVE_PATH);
    if (kind === "symlink") symlinkSync(external, mirror);
    else linkSync(external, mirror);
    syncProjectContext(workspace, "project", "New brief");
    assert.equal(readFileSync(external, "utf8"), "preserve host contents");
    assert.equal(lstatSync(mirror).isSymbolicLink(), false);
    assert.match(readFileSync(mirror, "utf8"), /New brief/);
  });
}

for (const brief of ["New brief", undefined]) {
  test(`project brief rejects a symlinked control directory when ${brief ? "writing" : "removing"}`, (t) => {
    const root = mkdtempSync(join(tmpdir(), "relay-project-control-link-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const workspace = join(root, "workspace");
    const external = join(root, "external");
    mkdirSync(workspace); mkdirSync(external);
    writeFileSync(join(external, "PROJECT.md"), "preserve host contents");
    symlinkSync(external, join(workspace, ".relay"), process.platform === "win32" ? "junction" : "dir");
    assert.throws(() => syncProjectContext(workspace, "project", brief), /symbolic link/);
    assert.equal(readFileSync(join(external, "PROJECT.md"), "utf8"), "preserve host contents");
  });
}
