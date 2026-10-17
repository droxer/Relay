import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
    progress_file: "threads/ses_one/HANDOFF.md",
    legacy_progress_file: "HANDOFF.md",
  });
  assert.match(prompt, /Write generated deliverables to `artifacts\//);
  assert.match(prompt, /threads\/ses_one\/HANDOFF.md/);
  assert.match(prompt, /previous record `HANDOFF.md`/);
});

test("workspace records isolate threads and share artifacts within their durable scope", () => {
  const root = mkdtempSync(join(tmpdir(), "relay-records-"));
  try {
    const manager = new ThreadWorkspaceManager(root, "none");
    for (const subpath of ["ses_single", "tasks/automation/run_one", "tasks/automation/run_two", "projects/project_one"]) {
      const workspace = manager.ensureSubpath("ses_one", subpath);
      manager.ensureRecords(workspace);
      manager.ensureRecords({ ...workspace, sessionId: "ses_two" });
      assert.ok(existsSync(join(workspace.hostPath, "threads/ses_one")));
      assert.ok(existsSync(join(workspace.hostPath, "threads/ses_two")));
      assert.ok(existsSync(join(workspace.hostPath, "artifacts")));
      writeFileSync(join(workspace.hostPath, "artifacts/report.md"), "result");
      writeFileSync(join(workspace.hostPath, "threads/ses_one/HANDOFF.json"), "{}");
      for (const file of diffGeneratedFiles(workspace.hostPath, {})) {
        assert.ok(file.contentBase64, file.relativePath);
      }
      writeFileSync(join(workspace.hostPath, "threads/ses_two/HANDOFF.json"), "{}");
      const ownFiles = diffGeneratedFiles(workspace.hostPath, {}, { ownThreadId: "ses_one" });
      assert.ok(ownFiles.some(file => file.relativePath === "artifacts/report.md"));
      assert.ok(ownFiles.some(file => file.relativePath === "threads/ses_one/HANDOFF.json"));
      assert.ok(ownFiles.every(file => !file.relativePath.startsWith("threads/ses_two/")));
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("record and artifact directories reject symlink escapes", () => {
  const root = mkdtempSync(join(tmpdir(), "relay-records-"));
  const outside = mkdtempSync(join(tmpdir(), "relay-records-outside-"));
  try {
    const manager = new ThreadWorkspaceManager(root, "none");
    for (const subpath of ["artifacts", "threads", "threads/ses_one"]) {
      const workspace = manager.ensure(`ses_${subpath.replaceAll("/", "_")}`);
      mkdirSync(join(workspace.hostPath, "threads"), { recursive: true });
      if (subpath === "threads") rmSync(join(workspace.hostPath, "threads"), { recursive: true });
      symlinkSync(outside, join(workspace.hostPath, subpath));
      assert.throws(() => manager.ensureRecords({ ...workspace, sessionId: "ses_one" }), /symbolic link/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
