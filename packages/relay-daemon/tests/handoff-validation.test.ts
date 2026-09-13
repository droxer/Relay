import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { DaemonNodeRunCommand } from "relay-core";
import { validateHandoffWorkspace } from "../src/handoff-validation.js";

function command(): DaemonNodeRunCommand {
  return {
    id: "command", type: "run.start", sessionId: "thread", runId: "run",
    taskGoal: "work", agent: "codex", assignmentId: "receiver", workspaceLayout: "thread",
    handoffValidation: {
      contract: { name: "relay.handoff.validation", version: 1 }, assignmentId: "receiver",
      workspaceLayout: "thread", workspaceSubpath: null,
      artifacts: [{ artifactId: "snapshot", path: "output/result.md", sha256: createHash("sha256").update("recorded").digest("hex") }],
    },
  };
}

test("matches raw file hashes, preserves unknown evidence, and never rewrites commands", () => {
  const root = mkdtempSync(join(tmpdir(), "relay-validate-"));
  try {
    mkdirSync(join(root, "output"));
    writeFileSync(join(root, "output/result.md"), "recorded");
    const input = command();
    input.handoffValidation!.artifacts.push({ artifactId: "unknown", path: "absent.md", sha256: null });
    const before = structuredClone(input);
    assert.match(validateHandoffWorkspace(root, input)!, /1 recorded file hashes matched; 1 snapshots unavailable/);
    assert.deepEqual(input, before);
    input.handoffValidation!.artifacts = [];
    assert.match(validateHandoffWorkspace(root, input)!, /0 recorded file hashes matched/);
    delete input.handoffValidation;
    assert.equal(validateHandoffWorkspace(root, input), undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const variant of ["changed", "missing", "directory", "large", "leaf-link", "parent-link"] as const) {
  test(`rejects ${variant} evidence without exposing file contents`, () => {
    const root = mkdtempSync(join(tmpdir(), "relay-validate-"));
    try {
      mkdirSync(join(root, "output"));
      const path = join(root, "output/result.md");
      if (variant === "changed") writeFileSync(path, "private changed data");
      if (variant === "directory") mkdirSync(path);
      if (variant === "large") writeFileSync(path, Buffer.alloc(2 * 1024 * 1024 + 1));
      if (variant === "leaf-link") symlinkSync(join(root, "not-present"), path);
      const input = command();
      if (variant === "parent-link") {
        symlinkSync(tmpdir(), join(root, "linked"));
        input.handoffValidation!.artifacts[0].path = "linked/result.md";
      }
      assert.throws(() => validateHandoffWorkspace(root, input), (error: unknown) => {
        assert.match(String(error), /handoff_validation_failed/);
        assert.doesNotMatch(String(error), /private changed data/);
        assert.ok(!String(error).includes(root));
        return true;
      });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

for (const path of ["", "/outside", "../outside", "output/../file", "output//file", "./file", "C:\\file", "file\0.md", "a".repeat(513)]) {
  test(`rejects unsafe relative path ${JSON.stringify(path)}`, () => {
    const input = command();
    input.handoffValidation!.artifacts[0].path = path;
    assert.throws(() => validateHandoffWorkspace("/unused", input), /invalid artifact/);
  });
}

for (const patch of [
  null, {}, { contract: { name: "relay.handoff.validation", version: 99 } },
  { assignmentId: "other" }, { workspaceLayout: "node-root" }, { workspaceSubpath: "other" },
  { artifacts: null }, { artifacts: Array(25).fill({}) },
  { artifacts: [{ artifactId: "snapshot", path: "file", sha256: "wrong" }] },
]) {
  test(`rejects malformed validation ${JSON.stringify(patch)}`, () => {
    const input = command();
    Object.assign(input, { handoffValidation: patch === null ? null : { ...input.handoffValidation, ...patch } });
    // An empty patch retains a valid payload; test an absent assignment instead.
    if (patch && Object.keys(patch).length === 0) delete (input.handoffValidation as Partial<NonNullable<DaemonNodeRunCommand["handoffValidation"]>>).assignmentId;
    assert.throws(() => validateHandoffWorkspace("/unused", input), /handoff_validation_failed/);
  });
}
