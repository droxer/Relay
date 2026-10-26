import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ThreadWorkspaceManager } from "../src/thread-workspace.js";
import { diffGeneratedFiles } from "../src/generated-files.js";
import { agentTaskPrompt, initialAgentState } from "relay-core";

test("agent prompts distinguish deliverables from thread progress", () => {
  const prompt = agentTaskPrompt({
    ...initialAgentState("Write a report"),
    artifacts_dir: "artifacts",
    progress_file: ".relay/threads/ses_one/HANDOFF.md",
    legacy_progress_file: "HANDOFF.md",
  });
  assert.match(prompt, /Write generated deliverables to `artifacts\//);
  assert.match(prompt, /\.relay\/threads\/ses_one\/HANDOFF.md/);
  assert.match(prompt, /previous record `HANDOFF.md`/);
});

test("agent prompts name the project workspace itself as the deliverable location", () => {
  const prompt = agentTaskPrompt({
    ...initialAgentState("Write a report"),
    deliverables_in_workspace: true,
    progress_file: ".relay/threads/ses_one/HANDOFF.md",
  });
  assert.match(prompt, /workspace is the deliverable location/);
  assert.match(prompt, /do not create an `artifacts\/` directory/);
  assert.doesNotMatch(prompt, /Write generated deliverables to/);
});

test("workspace records isolate threads and share artifacts within their durable scope", async () => {
  const root = mkdtempSync(join(tmpdir(), "relay-records-"));
  try {
    const manager = new ThreadWorkspaceManager(root, "none");
    for (const subpath of ["ses_single", "tasks/tsk_one"]) {
      const workspace = manager.ensureSubpath("ses_one", subpath);
      manager.ensureRecords(workspace, "artifacts");
      manager.ensureRecords({ ...workspace, sessionId: "ses_two" }, "artifacts");
      assert.ok(existsSync(join(workspace.hostPath, ".relay/threads/ses_one")));
      assert.ok(existsSync(join(workspace.hostPath, ".relay/threads/ses_two")));
      assert.ok(existsSync(join(workspace.hostPath, "artifacts")));
      writeFileSync(join(workspace.hostPath, "artifacts/report.md"), "result");
      writeFileSync(join(workspace.hostPath, ".relay/threads/ses_one/HANDOFF.json"), "{}");
      for (const file of await diffGeneratedFiles(workspace.hostPath, {})) {
        assert.ok(file.contentBase64, file.relativePath);
      }
      writeFileSync(join(workspace.hostPath, ".relay/threads/ses_two/HANDOFF.json"), "{}");
      const ownFiles = await diffGeneratedFiles(workspace.hostPath, {}, { ownThreadId: "ses_one" });
      assert.ok(ownFiles.some(file => file.relativePath === "artifacts/report.md"));
      assert.ok(ownFiles.some(file => file.relativePath === ".relay/threads/ses_one/HANDOFF.json"));
      assert.ok(ownFiles.every(file => !file.relativePath.startsWith(".relay/threads/ses_two/")));
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a backend that names no artifacts directory still gets artifacts/", () => {
  const root = mkdtempSync(join(tmpdir(), "relay-records-"));
  try {
    const manager = new ThreadWorkspaceManager(root, "none");
    const workspace = manager.ensure("ses_one");
    manager.ensureRecords(workspace);
    assert.ok(existsSync(join(workspace.hostPath, "artifacts")));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("automation runs share one directory and keep their artifacts apart", async () => {
  const root = mkdtempSync(join(tmpdir(), "relay-records-"));
  try {
    const manager = new ThreadWorkspaceManager(root, "none");
    const workspace = manager.ensureSubpath("ses_one", "tasks/automation");
    manager.ensureRecords(workspace, "artifacts/run_one");
    manager.ensureRecords({ ...workspace, sessionId: "ses_two" }, "artifacts/run_two");
    assert.ok(existsSync(join(workspace.hostPath, "artifacts/run_one")));
    assert.ok(existsSync(join(workspace.hostPath, "artifacts/run_two")));
    assert.ok(existsSync(join(workspace.hostPath, ".relay/threads/ses_one")));
    assert.ok(existsSync(join(workspace.hostPath, ".relay/threads/ses_two")));
    writeFileSync(join(workspace.hostPath, "artifacts/run_one/report.md"), "result");
    const files = await diffGeneratedFiles(workspace.hostPath, {}, { ownThreadId: "ses_one" });
    assert.ok(files.some(file => file.relativePath === "artifacts/run_one/report.md" && file.contentBase64));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a project workspace gets thread records but no artifacts directory", () => {
  const root = mkdtempSync(join(tmpdir(), "relay-records-"));
  try {
    const manager = new ThreadWorkspaceManager(root, "none");
    const workspace = manager.ensureSubpath("ses_one", "projects/project_one");
    manager.ensureRecords(workspace, null);
    assert.ok(existsSync(join(workspace.hostPath, ".relay/threads/ses_one")));
    assert.ok(!existsSync(join(workspace.hostPath, "artifacts")));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("an escaping artifacts directory is refused", () => {
  const root = mkdtempSync(join(tmpdir(), "relay-records-"));
  try {
    const manager = new ThreadWorkspaceManager(root, "none");
    const workspace = manager.ensure("ses_one");
    for (const bad of ["../outside", "/tmp/abs", "artifacts/..", ""]) {
      assert.throws(() => manager.ensureRecords(workspace, bad), /Invalid durable workspace path/);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("record and artifact directories reject symlink escapes", () => {
  const root = mkdtempSync(join(tmpdir(), "relay-records-"));
  const outside = mkdtempSync(join(tmpdir(), "relay-records-outside-"));
  try {
    const manager = new ThreadWorkspaceManager(root, "none");
    for (const subpath of ["artifacts", ".relay", ".relay/threads", ".relay/threads/ses_one"]) {
      const workspace = manager.ensure(`ses_${subpath.replaceAll(/[./]/g, "_")}`);
      const parent = subpath.split("/").slice(0, -1).join("/");
      if (parent) mkdirSync(join(workspace.hostPath, parent), { recursive: true });
      symlinkSync(outside, join(workspace.hostPath, subpath));
      assert.throws(() => manager.ensureRecords({ ...workspace, sessionId: "ses_one" }), /symbolic link/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

for (const older of ["threads", ".threads"]) {
  test(`a project keeps no ${older}/ folder: older records move into .relay/threads/`, () => {
    const root = mkdtempSync(join(tmpdir(), "relay-records-"));
    try {
      const manager = new ThreadWorkspaceManager(root, "none");
      const workspace = manager.ensureSubpath("ses_one", "projects/project_one");
      mkdirSync(join(workspace.hostPath, `${older}/ses_one`), { recursive: true });
      writeFileSync(join(workspace.hostPath, `${older}/ses_one/HANDOFF.md`), "notes");
      manager.ensureRecords(workspace, null);
      assert.equal(readFileSync(join(workspace.hostPath, ".relay/threads/ses_one/HANDOFF.md"), "utf8"), "notes");
      assert.ok(!existsSync(join(workspace.hostPath, older)));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

test("a node root's thread workspaces under .threads/ are never taken for records", () => {
  const root = mkdtempSync(join(tmpdir(), "relay-records-"));
  try {
    const manager = new ThreadWorkspaceManager(root, "none");
    const thread = manager.ensure("ses_one");
    manager.ensureRecords(thread);
    writeFileSync(join(thread.hostPath, "report.md"), "work");
    manager.ensureRecords(manager.nodeRoot("ses_one"));
    assert.ok(existsSync(join(root, ".threads/ses_one/report.md")));
    assert.ok(existsSync(join(root, ".threads/ses_one/.relay/threads/ses_one")));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a threads/ folder holding anything but records is left alone", () => {
  const root = mkdtempSync(join(tmpdir(), "relay-records-"));
  try {
    const manager = new ThreadWorkspaceManager(root, "none");
    const workspace = manager.ensureSubpath("ses_one", "projects/project_one");
    mkdirSync(join(workspace.hostPath, "threads/ses_one"), { recursive: true });
    writeFileSync(join(workspace.hostPath, "threads/ses_one/notes.txt"), "the user's");
    manager.ensureRecords(workspace, null);
    assert.ok(existsSync(join(workspace.hostPath, "threads/ses_one/notes.txt")));
    assert.ok(existsSync(join(workspace.hostPath, ".relay/threads/ses_one")));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("an older backend that names threads/ keeps its records there", () => {
  const root = mkdtempSync(join(tmpdir(), "relay-records-"));
  try {
    const manager = new ThreadWorkspaceManager(root, "none");
    const workspace = manager.ensureSubpath("ses_one", "projects/project_one");
    manager.ensureRecords(workspace, null, "threads");
    assert.ok(existsSync(join(workspace.hostPath, "threads/ses_one")));
    assert.ok(!existsSync(join(workspace.hostPath, ".threads")));
    assert.ok(!existsSync(join(workspace.hostPath, ".relay")));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a backend that names .threads/ keeps its records there and moves threads/ in", () => {
  const root = mkdtempSync(join(tmpdir(), "relay-records-"));
  try {
    const manager = new ThreadWorkspaceManager(root, "none");
    const workspace = manager.ensureSubpath("ses_one", "projects/project_one");
    mkdirSync(join(workspace.hostPath, "threads/ses_one"), { recursive: true });
    writeFileSync(join(workspace.hostPath, "threads/ses_one/HANDOFF.md"), "notes");
    manager.ensureRecords(workspace, null, ".threads");
    assert.equal(readFileSync(join(workspace.hostPath, ".threads/ses_one/HANDOFF.md"), "utf8"), "notes");
    assert.ok(!existsSync(join(workspace.hostPath, ".relay")));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("only a thread's own records are walked inside .relay/", async () => {
  const root = mkdtempSync(join(tmpdir(), "relay-records-"));
  try {
    const manager = new ThreadWorkspaceManager(root, "none");
    const workspace = manager.ensure("ses_one");
    manager.ensureRecords(workspace);
    writeFileSync(join(workspace.hostPath, ".relay/PROJECT.md"), "brief");
    writeFileSync(join(workspace.hostPath, ".relay/threads/ses_one/HANDOFF.md"), "notes");
    const files = await diffGeneratedFiles(workspace.hostPath, {}, { ownThreadId: "ses_one" });
    assert.deepEqual(files.map(file => file.relativePath), [".relay/threads/ses_one/HANDOFF.md"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
