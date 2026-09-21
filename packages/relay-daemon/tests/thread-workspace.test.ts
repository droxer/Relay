import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ThreadWorkspaceManager } from "../src/thread-workspace.js";

test("thread workspaces are persistent and isolated beneath the configured local root", () => {
  const root = mkdtempSync(join(tmpdir(), "relay-thread-workspaces-"));
  try {
    const manager = new ThreadWorkspaceManager(root, "none");

    const first = manager.ensure("ses_first");
    const same = manager.ensure("ses_first");
    const second = manager.ensure("ses_second");

    assert.equal(first.hostPath, join(root, "ses_first"));
    assert.equal(first.executionPath, first.hostPath);
    assert.deepEqual(same, first);
    assert.equal(second.hostPath, join(root, "ses_second"));
    assert.notEqual(second.hostPath, first.hostPath);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("BoxLite mounts only the active thread at the guest workspace root", () => {
  const root = mkdtempSync(join(tmpdir(), "relay-cloud-thread-workspaces-"));
  try {
    const workspace = new ThreadWorkspaceManager(root, "boxlite").ensure(
      "019fbff6-5fd8-71d1-8140-29fd1f767b39",
    );

    assert.equal(
      workspace.hostPath,
      join(root, "019fbff6-5fd8-71d1-8140-29fd1f767b39"),
    );
    assert.equal(workspace.executionPath, "/workspace");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("thread workspace ids cannot escape the configured root", () => {
  const root = mkdtempSync(join(tmpdir(), "relay-thread-workspace-security-"));
  const outside = mkdtempSync(join(tmpdir(), "relay-thread-workspace-outside-"));
  try {
    const manager = new ThreadWorkspaceManager(root, "none");

    for (const invalid of ["", ".", "..", "../escape", "nested/thread", "nested\\thread", "NUL", "COM1.txt", "ses_trailing."] as const) {
      assert.throws(() => manager.ensure(invalid), /Invalid thread id/);
    }

    symlinkSync(outside, join(root, "ses_link"));
    assert.throws(() => manager.ensure("ses_link"), /symbolic link/);

    mkdirSync(join(root, "ses_valid"));
    assert.equal(manager.ensure("ses_valid").hostPath, join(root, "ses_valid"));
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("thread workspace setup never creates the employee or supervisor configured root", () => {
  const parent = mkdtempSync(join(tmpdir(), "relay-thread-workspace-parent-"));
  try {
    const missingRoot = join(parent, "employee-selected-root");
    assert.throws(
      () => new ThreadWorkspaceManager(missingRoot, "none"),
      /ENOENT|no such file/i,
    );
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("project workspaces are shared by threads and remain below the configured root", () => {
  const root = mkdtempSync(join(tmpdir(), "relay-project-workspaces-"));
  try {
    const manager = new ThreadWorkspaceManager(root, "none");
    const first = manager.ensureSubpath("ses_first", "projects/prj_one");
    const second = manager.ensureSubpath("ses_second", "projects/prj_one");

    assert.equal(first.hostPath, join(root, "projects", "prj_one"));
    assert.equal(second.hostPath, first.hostPath);
    assert.equal(second.executionPath, first.executionPath);
    assert.equal(first.sessionId, "ses_first");
    assert.equal(second.sessionId, "ses_second");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("project workspace paths cannot traverse or escape through a symlink", () => {
  const root = mkdtempSync(join(tmpdir(), "relay-project-workspace-security-"));
  const outside = mkdtempSync(join(tmpdir(), "relay-project-workspace-outside-"));
  try {
    const manager = new ThreadWorkspaceManager(root, "none");
    for (const invalid of ["", ".", "..", "../escape", "/absolute", "projects/../../escape", "projects\\escape"] as const) {
      assert.throws(() => manager.ensureSubpath("ses_one", invalid), /Invalid durable workspace path/);
    }
    mkdirSync(join(root, "projects"));
    symlinkSync(outside, join(root, "projects", "linked"));
    assert.throws(
      () => manager.ensureSubpath("ses_one", "projects/linked"),
      /symbolic link|escapes the configured root/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("project deletion removes only its canonical workspace and is idempotent", () => {
  const root = mkdtempSync(join(tmpdir(), "relay-project-delete-"));
  try {
    const manager = new ThreadWorkspaceManager(root, "none");
    manager.ensureSubpath("project-one", "projects/project-one");
    const other = manager.ensureSubpath("project-two", "projects/project-two");
    manager.deleteProject("project-one", "projects/project-one");
    manager.deleteProject("project-one", "projects/project-one");
    assert.throws(() => realpathSync(join(root, "projects/project-one")), /ENOENT/);
    assert.equal(realpathSync(other.hostPath), realpathSync(join(root, "projects/project-two")));
    for (const path of ["", "projects", "projects/project-two", "../outside", root]) {
      assert.throws(() => manager.deleteProject("project-one", path));
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("project deletion rejects symlink roots and does not follow child symlinks", () => {
  const root = mkdtempSync(join(tmpdir(), "relay-project-delete-"));
  const outside = mkdtempSync(join(tmpdir(), "relay-project-outside-"));
  try {
    const manager = new ThreadWorkspaceManager(root, "none");
    mkdirSync(join(root, "projects"));
    symlinkSync(outside, join(root, "projects/project-one"));
    assert.throws(() => manager.deleteProject("project-one", "projects/project-one"), /symbolic link/);
    rmSync(join(root, "projects/project-one"));
    manager.ensureSubpath("project-one", "projects/project-one");
    symlinkSync(outside, join(root, "projects/project-one/external"));
    manager.deleteProject("project-one", "projects/project-one");
    assert.equal(realpathSync(outside), realpathSync(outside));
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
