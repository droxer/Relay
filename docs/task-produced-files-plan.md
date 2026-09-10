# Produced Files Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace a task's two separate file sections — the artifact index and the live workspace browser — with one Files surface where provenance, durability, and currency are per-file properties.

**Architecture:** The daemon widens *which* changed files it reports (every one, not just documents) while keeping *what it stores* exactly as narrow as today. Each reported file carries a `snapshotSkipped` reason when no bytes were attached. A new `GET /tasks/{id}/files` endpoint merges the produced-file index with live directory listings, derives a currency state per file, and never fails when the computer is down. The web drawer renders one section: produced files as the primary tier, unclaimed live entries as a collapsed secondary tier.

**Tech Stack:** TypeScript (Node ≥ 22.19, `node --test` against built JS) for `relay-core` and `relay-daemon`; Python 3.12 + FastAPI + pytest for the backend; React + TanStack Query + i18next for `web/`.

**Spec:** `docs/task-produced-files-design.md`

## Global Constraints

- **Snapshotting must not widen.** Only paths passing `is_snapshotable_path` / `isSnapshotableFile` may have bytes stored. This is the entire safety argument of the design — no task may relax it.
- **The backend does not trust the daemon's storage decision.** Content arriving for a non-snapshotable path is discarded server-side.
- **Sensitive-named files are excluded outright**, not reported as metadata rows. The rule is `SENSITIVE_FILE_NAME` regex match, or name `.env`, or name starting with `.env.` — implemented identically in `generated-files.ts` and `artifacts.py`.
- **`snapshotSkipped` enum, exactly these four values:** `"too-large"` (over per-file cap *or* per-event budget), `"not-snapshotable-type"`, `"sensitive"`, `"unreadable"`.
- **Capability gate:** new behavior ships behind `"produced-files"`. A daemon without it must index exactly as it does today.
- **Content budget is unchanged:** `GENERATED_FILE_CONTENT_MAX_BYTES` 2 MB per file, `GENERATED_FILE_CONTENT_TOTAL_MAX_BYTES` 8 MB per event.
- **Mirror-comment contract:** `generated-files.ts` and `artifacts.py` carry paired predicates. Any change to one must change the other and say so in both comments.
- **No renames.** `kind: "workspace_file"`, `index_workspace_artifact`, `is_workspace_artifact`, `workspace_artifacts`, `artifact_index_item`, and the existing `/artifacts` routes keep their names.
- **Build before testing TypeScript:** `npm run build` then `node --test dist/packages/<pkg>/tests/<file>.js`.

---

### Task 1: Protocol — `snapshotSkipped` and the `produced-files` capability

Define the shared names first so no later task forward-references them. This task is types and constants plus the spec refinement that introduced the fourth enum value.

**Files:**
- Modify: `packages/relay-core/src/daemon-node-protocol.ts:57-63` (capability union and constants), `:92-104` (`DaemonGeneratedFile`)
- Test: `packages/relay-core/tests/handoff.test.ts` (append)

**Interfaces:**
- Consumes: nothing.
- Produces: `type SnapshotSkippedReason = "too-large" | "not-snapshotable-type" | "sensitive" | "unreadable"`; `DaemonGeneratedFile.snapshotSkipped?: SnapshotSkippedReason`; `DAEMON_CAPABILITY_PRODUCED_FILES: DaemonNodeCapability` with value `"produced-files"`.

- [ ] **Step 1: Write the failing test**

Append to `packages/relay-core/tests/handoff.test.ts`:

```typescript
test("produced-files capability and snapshot reasons are on the wire protocol", async () => {
  const { DAEMON_CAPABILITY_PRODUCED_FILES } = await import("../src/daemon-node-protocol.js");
  assert.equal(DAEMON_CAPABILITY_PRODUCED_FILES, "produced-files");

  // A metadata-only report states why no bytes came with it; a snapshotted
  // one carries content and no reason. The type must permit exactly both.
  const skipped: DaemonGeneratedFile = {
    relativePath: "src/main.py",
    title: "main.py",
    bytes: 4096,
    contentType: "text/x-python",
    snapshotSkipped: "not-snapshotable-type",
  };
  const stored: DaemonGeneratedFile = {
    relativePath: "report.md",
    title: "report.md",
    bytes: 12,
    contentType: "text/markdown",
    contentBase64: "IyBSZXBvcnQK",
  };
  assert.equal(skipped.snapshotSkipped, "not-snapshotable-type");
  assert.equal(stored.snapshotSkipped, undefined);
});
```

Add `DaemonGeneratedFile` to the existing type import at the top of the file:

```typescript
import type { DaemonGeneratedFile } from "../src/daemon-node-protocol.js";
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build`
Expected: FAIL — `tsc` errors with "Object literal may only specify known properties, and 'snapshotSkipped' does not exist in type 'DaemonGeneratedFile'" and "Module has no exported member 'DAEMON_CAPABILITY_PRODUCED_FILES'".

- [ ] **Step 3: Write minimal implementation**

In `packages/relay-core/src/daemon-node-protocol.ts`, extend the capability union (line 62) and add the constant beside its siblings:

```typescript
export type DaemonNodeCapability = "generated-files" | "workspace-read-shared" | "structured-agent-events" | "thread-workspaces" | "project-workspaces" | "task-workspaces" | "round-result" | "produced-files";
export const DAEMON_CAPABILITY_GENERATED_FILES: DaemonNodeCapability = "generated-files";
/**
 * "produced-files" means the daemon reports every file a run changed, not only
 * document types, and states why any file arrived without a snapshot. A daemon
 * without it reports the older document-only set, which the backend still
 * indexes unchanged.
 */
export const DAEMON_CAPABILITY_PRODUCED_FILES: DaemonNodeCapability = "produced-files";
```

Replace the `DaemonGeneratedFile` interface:

```typescript
/**
 * Why a reported file arrived without bytes attached.
 *
 * "too-large" covers both the per-file cap and an exhausted per-event budget;
 * a reader only needs to know the size limits stopped it. "unreadable" means
 * the file vanished or could not be read between the walk and the read.
 */
export type SnapshotSkippedReason =
  | "too-large"
  | "not-snapshotable-type"
  | "sensitive"
  | "unreadable";

export interface DaemonGeneratedFile {
  /** Path relative to the run workspace (thread child or legacy node root). */
  relativePath: string;
  title: string;
  bytes: number;
  contentType: string;
  /**
   * Base64 file content for files small enough to snapshot, so the backend
   * can serve the artifact even without access to the daemon's filesystem
   * and after the workspace copy is deleted or rewritten.
   */
  contentBase64?: string;
  /**
   * Set when no snapshot was attached, so the record can say the file is
   * attributed but live-only rather than simply appearing to be missing.
   * Absent whenever `contentBase64` is present.
   */
  snapshotSkipped?: SnapshotSkippedReason;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build && node --test dist/packages/relay-core/tests/handoff.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/relay-core/src/daemon-node-protocol.ts packages/relay-core/tests/handoff.test.ts docs/task-produced-files-design.md
git commit -m "feat(protocol): add produced-files capability and snapshot-skip reasons

A reported file that arrives without bytes now says why, so a record can
distinguish 'not produced' from 'produced but not storable'."
```

---

### Task 2: Daemon reports every changed file; snapshotting stays narrow

The core behavior change. Candidacy widens to any changed file; the storage allowlist and the secret scan move from gating *reporting* to gating *snapshotting*.

**Files:**
- Modify: `packages/relay-daemon/src/generated-files.ts` (whole file restructure)
- Test: `packages/relay-daemon/tests/daemon.test.ts:2436-2505` (update three existing tests, add three)

**Interfaces:**
- Consumes: `DaemonGeneratedFile`, `SnapshotSkippedReason` from Task 1.
- Produces: `GeneratedFileCandidate` gains `snapshotable: boolean`; `isSnapshotableFile(relativePath, extension): boolean`; `GENERATED_FILE_EXCLUDED_NAMES: Set<string>`; `GENERATED_FILE_LIMIT` becomes `200`. `snapshotGeneratedFiles` and `diffGeneratedFiles` keep their existing signatures.

- [ ] **Step 1: Write the failing tests**

Replace the three existing generated-file tests in `packages/relay-daemon/tests/daemon.test.ts` (they assert the old narrow behavior and must change) and add three new ones:

```typescript
test("generated-file diff reports every changed file and skips excluded directories", async (t: TestContext) => {
  const { mkdtempSync, mkdirSync: makeDir, rmSync, writeFileSync: writeFile } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join: joinPath } = await import("node:path");
  const { snapshotGeneratedFiles, diffGeneratedFiles } = await import("../src/generated-files.js");
  const workspace = mkdtempSync(joinPath(tmpdir(), "relay-generated-diff-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));

  writeFile(joinPath(workspace, "data.csv"), "a,b\n");
  makeDir(joinPath(workspace, "node_modules"));
  writeFile(joinPath(workspace, "node_modules", "vendored.pdf"), "ignored");
  const before = snapshotGeneratedFiles(workspace);

  makeDir(joinPath(workspace, "output"));
  makeDir(joinPath(workspace, "src"));
  writeFile(joinPath(workspace, "report.html"), "<h1>hi</h1>");
  writeFile(joinPath(workspace, "data.csv"), "a,b\nc,d\n");
  writeFile(joinPath(workspace, "output", "summary.md"), "# Summary\n");
  // Source the run wrote is now output too — a coding task has deliverables.
  writeFile(joinPath(workspace, "src", "main.py"), "print('hi')\n");
  // A checkout's own README is reported now; it was changed by the run.
  makeDir(joinPath(workspace, "checkout"));
  writeFile(joinPath(workspace, "checkout", "README.md"), "someone else's repo\n");
  writeFile(joinPath(workspace, "package-lock.json"), "{}\n");

  const changed = diffGeneratedFiles(workspace, before);
  assert.deepEqual(changed.map((file) => file.relativePath).sort(), [
    "checkout/README.md",
    "data.csv",
    "output/summary.md",
    "report.html",
    "src/main.py",
  ]);
  assert.deepEqual(diffGeneratedFiles(workspace, snapshotGeneratedFiles(workspace)), []);
});

test("generated-file diff snapshots only allowlisted types and states why it skipped", async (t: TestContext) => {
  const { mkdtempSync, mkdirSync: makeDir, rmSync, writeFileSync: writeFile } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join: joinPath } = await import("node:path");
  const { diffGeneratedFiles } = await import("../src/generated-files.js");
  const workspace = mkdtempSync(joinPath(tmpdir(), "relay-generated-snapshot-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));

  makeDir(joinPath(workspace, "src"));
  writeFile(joinPath(workspace, "report.md"), "# Report\n");
  writeFile(joinPath(workspace, "src", "main.py"), "print('hi')\n");
  writeFile(joinPath(workspace, "bundle.zip"), "opaque archive");

  const byPath = new Map(
    diffGeneratedFiles(workspace, {}).map((file) => [file.relativePath, file]),
  );
  // A document beside the work is stored and readable offline.
  assert.equal(byPath.get("report.md")?.contentBase64, Buffer.from("# Report\n").toString("base64"));
  assert.equal(byPath.get("report.md")?.snapshotSkipped, undefined);
  // Source and archives are attributed but never stored.
  assert.equal(byPath.get("src/main.py")?.contentBase64, undefined);
  assert.equal(byPath.get("src/main.py")?.snapshotSkipped, "not-snapshotable-type");
  assert.equal(byPath.get("bundle.zip")?.snapshotSkipped, "not-snapshotable-type");
});

test("generated-file scan excludes credential names and never stores secret content", async (t: TestContext) => {
  const { mkdtempSync, rmSync, writeFileSync: writeFile } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join: joinPath } = await import("node:path");
  const { diffGeneratedFiles } = await import("../src/generated-files.js");
  const workspace = mkdtempSync(joinPath(tmpdir(), "relay-generated-secrets-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));

  writeFile(joinPath(workspace, "credentials.json"), '{"token":"tok_super_secret"}');
  writeFile(joinPath(workspace, ".env.local"), "OPENAI_API_KEY=sk-secret-value\n");
  writeFile(joinPath(workspace, "report.txt"), "OPENAI_API_KEY=sk-secret-value");
  writeFile(joinPath(workspace, "safe-report.txt"), "No secrets here.\n");

  const changed = diffGeneratedFiles(workspace, {});
  const byPath = new Map(changed.map((file) => [file.relativePath, file]));
  // A credential-named file is not even attributed: the name itself leaks.
  assert.equal(byPath.has("credentials.json"), false);
  assert.equal(byPath.has(".env.local"), false);
  // A document whose body trips the scanner is attributed but never stored.
  assert.equal(byPath.get("report.txt")?.contentBase64, undefined);
  assert.equal(byPath.get("report.txt")?.snapshotSkipped, "sensitive");
  assert.equal(byPath.get("safe-report.txt")?.contentBase64, Buffer.from("No secrets here.\n").toString("base64"));
});

test("generated-file scan reports text documents at an agent home root and output dir", async (t: TestContext) => {
  const { mkdtempSync, mkdirSync: makeDir, rmSync, writeFileSync: writeFile } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join: joinPath } = await import("node:path");
  const { diffGeneratedFiles } = await import("../src/generated-files.js");
  const workspace = mkdtempSync(joinPath(tmpdir(), "relay-generated-textdocs-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));

  const own = agentWorkspaceSubpath("agent_self");
  makeDir(joinPath(workspace, own, "output"), { recursive: true });
  makeDir(joinPath(workspace, own, "scratch"), { recursive: true });
  writeFile(joinPath(workspace, own, "guide.md"), "# Guide\n");
  writeFile(joinPath(workspace, own, "output", "report.txt"), "done\n");
  writeFile(joinPath(workspace, own, "scratch", "buffer.md"), "working notes\n");

  const byPath = new Map(
    diffGeneratedFiles(workspace, {}, { ownAgentHomeSubdir: own }).map((f) => [f.relativePath, f]),
  );
  // All three are reported now; placement decides only whether bytes are kept.
  assert.deepEqual([...byPath.keys()].sort(), [
    `${own}/guide.md`,
    `${own}/output/report.txt`,
    `${own}/scratch/buffer.md`,
  ]);
  assert.equal(byPath.get(`${own}/guide.md`)?.snapshotSkipped, undefined);
  assert.equal(byPath.get(`${own}/output/report.txt`)?.snapshotSkipped, undefined);
  assert.equal(byPath.get(`${own}/scratch/buffer.md`)?.snapshotSkipped, "not-snapshotable-type");
});

test("generated-file diff caps rows and stops storing once the budget is spent", async (t: TestContext) => {
  const { mkdtempSync, rmSync, writeFileSync: writeFile } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join: joinPath } = await import("node:path");
  const { diffGeneratedFiles, GENERATED_FILE_LIMIT } = await import("../src/generated-files.js");
  const workspace = mkdtempSync(joinPath(tmpdir(), "relay-generated-budget-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));

  assert.equal(GENERATED_FILE_LIMIT, 200);
  // 12 markdown files of 1 MB each: 8 fit the 8 MB event budget, 4 do not.
  const body = "x".repeat(1024 * 1024);
  for (let index = 0; index < 12; index += 1) {
    writeFile(joinPath(workspace, `doc-${index}.md`), body);
  }
  const changed = diffGeneratedFiles(workspace, {});
  assert.equal(changed.length, 12);
  const stored = changed.filter((file) => file.contentBase64 !== undefined);
  assert.equal(stored.length, 8);
  for (const file of changed.filter((f) => f.contentBase64 === undefined)) {
    assert.equal(file.snapshotSkipped, "too-large");
  }
});

test("generated-file diff reports far more than the old twenty-file ceiling", async (t: TestContext) => {
  const { mkdtempSync, rmSync, writeFileSync: writeFile } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join: joinPath } = await import("node:path");
  const { diffGeneratedFiles } = await import("../src/generated-files.js");
  const workspace = mkdtempSync(joinPath(tmpdir(), "relay-generated-many-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));

  for (let index = 0; index < 250; index += 1) {
    writeFile(joinPath(workspace, `module-${index}.py`), `# module ${index}\n`);
  }
  const changed = diffGeneratedFiles(workspace, {});
  assert.equal(changed.length, 200);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run build && node --test dist/packages/relay-daemon/tests/daemon.test.js`
Expected: FAIL — the diff test reports only `data.csv`, `output/summary.md`, `report.html` (missing `src/main.py` and `checkout/README.md`); `GENERATED_FILE_LIMIT` is 20, not 200; `snapshotSkipped` is never set.

- [ ] **Step 3: Write the implementation**

In `packages/relay-daemon/src/generated-files.ts`, update the module docstring and constants:

```typescript
/**
 * Workspace produced-file detection for daemon runs.
 *
 * The daemon snapshots the workspace before a run and diffs after a successful
 * one, reporting every new or changed file in its run.completed event so the
 * backend can index them without access to this machine's filesystem.
 *
 * Two separate decisions live here and must not be conflated:
 *
 *   Candidacy  — does this file earn a record at all? Every changed file does,
 *                except one whose *name* marks it as a credential.
 *   Storage    — do its bytes travel with the record? Only allowlisted types,
 *                under the size caps, whose content does not trip the secret
 *                scanner. This set has deliberately not widened.
 *
 * Mirrored in `is_produced_file_path` / `is_snapshotable_path`
 * (backend/relay/daemon_registry/artifacts.py); change both together.
 */
```

Rename nothing, but add the lockfile exclusion set next to `GENERATED_FILE_EXCLUDED_DIRS`:

```typescript
/** Dependency lockfiles churn on every install and are never a deliverable. */
export const GENERATED_FILE_EXCLUDED_NAMES = new Set([
  "Cargo.lock",
  "go.sum",
  "package-lock.json",
  "pnpm-lock.yaml",
  "poetry.lock",
  "uv.lock",
  "yarn.lock",
]);
```

Raise the limit, keeping the content budget untouched:

```typescript
/**
 * Row cap per report. Sized for "every changed file", not just documents;
 * with newest-first ordering this truncates the tail of a pathological run
 * rather than dropping recent work.
 */
export const GENERATED_FILE_LIMIT = 200;
```

Add `snapshotable` to the candidate type:

```typescript
export interface GeneratedFileCandidate {
  path: string;
  relativePath: string;
  title: string;
  bytes: number;
  mtimeMs: number;
  contentType: string;
  /** Whether this path's bytes may be stored. Candidacy is separate. */
  snapshotable: boolean;
}
```

Replace `isSensitiveCandidate` with the two narrower predicates it was doing at once:

```typescript
/** A credential-named file earns no record: the name alone is a leak. */
function isExcludedByName(name: string): boolean {
  return SENSITIVE_FILE_NAME.test(name) || name === ".env" || name.startsWith(".env.");
}

/**
 * Whether this path's bytes may travel with the record.
 *
 * Exactly the old candidacy rule: binary/document types anywhere, text
 * documents only near a workspace root. Widening this widens what Relay
 * stores and serves, so it stays as narrow as it was audited.
 */
export function isSnapshotableFile(relativePath: string, extension: string): boolean {
  return GENERATED_FILE_EXTENSIONS.has(extension) || isTextDocumentFile(relativePath, extension);
}

/** Whether a storable file's body looks like it carries a credential. */
function hasLikelySecretContent(path: string, extension: string, bytes: number): boolean {
  const textLike = OUTPUT_FILE_TEXT_EXTENSIONS.has(extension)
    || extension === ".csv"
    || extension === ".html"
    || extension === ".svg"
    || extension === ".tsv";
  if (!textLike || bytes > GENERATED_FILE_CONTENT_MAX_BYTES) return false;
  try {
    return LIKELY_SECRET_CONTENT.test(readFileSync(path, "utf8"));
  } catch {
    return true;
  }
}
```

In `listCandidates`, replace the two filtering lines (currently `if (!GENERATED_FILE_EXTENSIONS.has(extension) && !isTextDocumentFile(...)) continue;` and `if (isSensitiveCandidate(...)) continue;`) and the `files.push` block:

```typescript
      if (!entry.isFile() || entry.name.startsWith("~$")) continue;
      if (isExcludedByName(entry.name) || GENERATED_FILE_EXCLUDED_NAMES.has(entry.name)) continue;
      const extension = fileExtension(entry.name);
      let stat;
      try {
        stat = lstatSync(path);
      } catch {
        continue;
      }
      if (!stat.isFile()) continue;
      const relativePath = relative(workspacePath, path).split(sep).join("/");
      files.push({
        path,
        relativePath,
        title: entry.name,
        bytes: stat.size,
        mtimeMs: stat.mtimeMs,
        contentType: CONTENT_TYPES[extension] ?? "application/octet-stream",
        snapshotable: isSnapshotableFile(relativePath, extension),
      });
```

Note the `isExcludedByName` check moves *above* the `lstatSync` call so a credential-named file is never even stat'd.

Replace `diffGeneratedFiles`'s map body so every path that declines to store says why:

```typescript
  let contentBudget = GENERATED_FILE_CONTENT_TOTAL_MAX_BYTES;
  return changed.map((item) => {
    const file: DaemonGeneratedFile = {
      relativePath: item.relativePath,
      title: item.title,
      bytes: item.bytes,
      contentType: item.contentType,
    };
    if (!item.snapshotable) {
      file.snapshotSkipped = "not-snapshotable-type";
      return file;
    }
    if (item.bytes > GENERATED_FILE_CONTENT_MAX_BYTES || item.bytes > contentBudget) {
      file.snapshotSkipped = "too-large";
      return file;
    }
    if (hasLikelySecretContent(item.path, fileExtension(item.title), item.bytes)) {
      file.snapshotSkipped = "sensitive";
      return file;
    }
    try {
      const body = readFileSync(item.path);
      file.contentBase64 = body.toString("base64");
      file.bytes = body.length;
      contentBudget -= body.length;
    } catch {
      // The file vanished between the walk and the read.
      file.snapshotSkipped = "unreadable";
    }
    return file;
  });
```

Add `SnapshotSkippedReason` is not needed as an import — `DaemonGeneratedFile` already types the field.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run build && node --test dist/packages/relay-daemon/tests/daemon.test.js`
Expected: PASS, all six generated-file tests.

- [ ] **Step 5: Commit**

```bash
git add packages/relay-daemon/src/generated-files.ts packages/relay-daemon/tests/daemon.test.ts
git commit -m "feat(daemon): report every changed file, keep snapshotting narrow

Candidacy and storage were one decision made by an extension allowlist, so
a coding task produced nothing at all. They are now separate: any changed
file earns a record, and only the types already audited for storage carry
bytes. Credential-named files are still excluded outright."
```

---

### Task 3: Daemon advertises the `produced-files` capability

**Files:**
- Modify: `packages/relay-daemon/src/index.ts:289-296` (capability array), plus its import block
- Test: `packages/relay-daemon/tests/daemon.test.ts` (append)

**Interfaces:**
- Consumes: `DAEMON_CAPABILITY_PRODUCED_FILES` from Task 1.
- Produces: registration payloads containing `"produced-files"` in `capabilities`.

- [ ] **Step 1: Write the failing test**

Find the existing registration test in `packages/relay-daemon/tests/daemon.test.ts` that asserts on the `capabilities` array and append beside it:

```typescript
test("daemon advertises produced-files so the backend knows which report semantics it sends", async () => {
  const { DAEMON_CAPABILITY_PRODUCED_FILES } = await import("relay-core");
  const registration = await captureRegistration();
  assert.ok(
    registration.capabilities.includes(DAEMON_CAPABILITY_PRODUCED_FILES),
    `expected produced-files in ${JSON.stringify(registration.capabilities)}`,
  );
});
```

If no `captureRegistration` helper exists in that file, reuse whatever the neighbouring registration test uses to read the posted body — the assertion is the point, not the plumbing.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && node --test dist/packages/relay-daemon/tests/daemon.test.js`
Expected: FAIL — `expected produced-files in ["generated-files","workspace-read-shared",...]`

- [ ] **Step 3: Write minimal implementation**

In `packages/relay-daemon/src/index.ts`, add the constant to the existing `relay-core` import and to the capability array:

```typescript
    capabilities: [
      DAEMON_CAPABILITY_GENERATED_FILES,
      DAEMON_CAPABILITY_PRODUCED_FILES,
      DAEMON_CAPABILITY_WORKSPACE_READ_SHARED,
      DAEMON_CAPABILITY_STRUCTURED_AGENT_EVENTS,
      DAEMON_CAPABILITY_THREAD_WORKSPACES,
      DAEMON_CAPABILITY_PROJECT_WORKSPACES,
      DAEMON_CAPABILITY_TASK_WORKSPACES,
      DAEMON_CAPABILITY_ROUND_RESULT,
    ],
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build && node --test dist/packages/relay-daemon/tests/daemon.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/relay-daemon/src/index.ts packages/relay-daemon/tests/daemon.test.ts
git commit -m "feat(daemon): advertise the produced-files capability at registration"
```

---

### Task 4: Backend splits the path predicates and refuses untrusted content

The backend must not take the daemon's word for what may be stored. It re-derives the storage decision from the path and discards content that should not have been sent.

**Files:**
- Modify: `backend/relay/daemon_registry/artifacts.py:73-92` (predicate split), `:212-257` (`daemon_reported_generated_files`)
- Test: Create `backend/tests/unit/test_produced_files.py`

**Interfaces:**
- Consumes: nothing from earlier tasks (mirrors Task 2's rules independently).
- Produces: `is_produced_file_path(relative_path: str) -> bool`; `is_snapshotable_path(relative_path: str) -> bool`; `daemon_reported_generated_files(workspace_path: str | None, raw_files: list[Any], *, produced_files: bool = False) -> list[dict[str, Any]]` where each item gains `"snapshotSkipped": str | None`.

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/unit/test_produced_files.py`:

```python
from __future__ import annotations

import base64

from relay.daemon_registry.artifacts import (
    daemon_reported_generated_files,
    is_produced_file_path,
    is_snapshotable_path,
)


def test_candidacy_accepts_any_path_but_never_a_credential_name() -> None:
    assert is_produced_file_path("src/main.py")
    assert is_produced_file_path("checkout/README.md")
    assert is_produced_file_path("report.md")
    assert not is_produced_file_path(".env")
    assert not is_produced_file_path("config/.env.local")
    assert not is_produced_file_path("deploy/credentials.json")
    assert not is_produced_file_path("keys/private_key.pem")


def test_storage_allowlist_is_unchanged_by_the_wider_candidacy() -> None:
    # Documents and binaries anywhere.
    assert is_snapshotable_path("decks/quarterly.pptx")
    assert is_snapshotable_path("chart.png")
    # Text documents only near a workspace root.
    assert is_snapshotable_path("report.md")
    assert is_snapshotable_path("output/summary.txt")
    assert not is_snapshotable_path("checkout/README.md")
    # Source is never storable.
    assert not is_snapshotable_path("src/main.py")


def _raw(relative: str, *, content: bytes | None = None, skipped: str | None = None) -> dict:
    raw: dict = {"relativePath": relative, "title": relative.split("/")[-1], "bytes": 12, "contentType": "text/plain"}
    if content is not None:
        raw["contentBase64"] = base64.b64encode(content).decode("ascii")
    if skipped is not None:
        raw["snapshotSkipped"] = skipped
    return raw


def test_produced_files_capability_widens_which_reports_are_indexed() -> None:
    raw = [_raw("src/main.py", skipped="not-snapshotable-type"), _raw("report.md", content=b"# Report")]

    narrow = daemon_reported_generated_files("/ws", raw)
    assert [item["relativePath"] for item in narrow] == ["report.md"]

    wide = daemon_reported_generated_files("/ws", raw, produced_files=True)
    assert [item["relativePath"] for item in wide] == ["src/main.py", "report.md"]
    assert wide[0]["content"] is None
    assert wide[0]["snapshotSkipped"] == "not-snapshotable-type"
    assert wide[1]["content"] == b"# Report"
    assert wide[1]["snapshotSkipped"] is None


def test_content_for_a_non_snapshotable_path_is_discarded() -> None:
    # A daemon must not be able to widen what the backend stores by sending
    # bytes for a path the storage allowlist rejects.
    raw = [_raw("src/main.py", content=b"print('hi')")]
    items = daemon_reported_generated_files("/ws", raw, produced_files=True)
    assert items[0]["content"] is None
    assert items[0]["snapshotSkipped"] == "not-snapshotable-type"


def test_a_credential_named_file_is_dropped_even_when_reported() -> None:
    raw = [_raw("deploy/credentials.json", content=b"{}"), _raw("report.md", content=b"ok")]
    items = daemon_reported_generated_files("/ws", raw, produced_files=True)
    assert [item["relativePath"] for item in items] == ["report.md"]


def test_an_unknown_skip_reason_is_normalised_away() -> None:
    raw = [_raw("src/main.py", skipped="because-i-said-so")]
    items = daemon_reported_generated_files("/ws", raw, produced_files=True)
    # The backend re-derives the reason it can prove rather than echoing input.
    assert items[0]["snapshotSkipped"] == "not-snapshotable-type"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run --project backend pytest backend/tests/unit/test_produced_files.py -v`
Expected: FAIL with `ImportError: cannot import name 'is_produced_file_path'`

- [ ] **Step 3: Write the implementation**

In `backend/relay/daemon_registry/artifacts.py`, add `re` to the imports and define the sensitive-name mirror plus the split predicates, replacing `_is_generated_artifact_path`:

```python
SNAPSHOT_SKIPPED_REASONS = frozenset(
    {"too-large", "not-snapshotable-type", "sensitive", "unreadable"}
)

# Mirrors SENSITIVE_FILE_NAME in packages/relay-daemon/src/generated-files.ts.
# Defence in depth: the daemon already drops these, and the backend drops them
# again so a compromised or stale daemon cannot register a credential's name.
SENSITIVE_FILE_NAME = re.compile(
    r"(?:^|[._-])(credential|credentials|secret|secrets|token|tokens|password"
    r"|passwd|api[._-]?key|private[._-]?key)(?:[._-]|$)",
    re.IGNORECASE,
)


def _is_sensitive_name(name: str) -> bool:
    return bool(SENSITIVE_FILE_NAME.search(name)) or name == ".env" or name.startswith(".env.")


def is_produced_file_path(relative_path: str) -> bool:
    """Whether a run-changed workspace path earns a produced-file record.

    Permissive by design: any file a run touched is that run's output. Only a
    credential-*named* file is refused, because the name itself is a leak.
    Mirrored in ``isExcludedByName``
    (packages/relay-daemon/src/generated-files.ts); change both together.
    """
    return not _is_sensitive_name(PurePosixPath(relative_path).name)


def is_snapshotable_path(relative_path: str) -> bool:
    """Whether a produced file's bytes may be stored and served.

    Binary/document types count anywhere. Text documents count only near a
    workspace root: directly in the thread workspace, directly in an agent's
    own home, or under an ``output/`` directory in either — so a guide an agent
    writes beside its work is stored while a checkout's ``README.md`` is not.
    This set has deliberately not widened along with candidacy: it is the
    surface the secret scanner was audited against. Mirrored in
    ``isSnapshotableFile`` (packages/relay-daemon/src/generated-files.ts);
    change both together.
    """
    path = PurePosixPath(relative_path)
    suffix = path.suffix.lower()
    if suffix in GENERATED_ARTIFACT_EXTENSIONS:
        return True
    if suffix not in OUTPUT_ARTIFACT_TEXT_EXTENSIONS:
        return False
    parts = path.parts
    if len(parts) >= 3 and parts[0] == "agents" and parts[1].startswith("agent-"):
        parts = parts[2:]
    return len(parts) == 1 or parts[0] == "output"
```

Then rewrite `daemon_reported_generated_files`:

```python
def daemon_reported_generated_files(
    workspace_path: str | None,
    raw_files: list[Any],
    *,
    produced_files: bool = False,
) -> list[dict[str, Any]]:
    """Sanitize a daemon generated-file report into indexable items.

    ``produced_files`` reflects the reporting daemon's capability. Without it
    the older document-only rule decides candidacy, so an un-upgraded daemon
    indexes exactly as it always did.
    """
    items: list[dict[str, Any]] = []
    for raw in raw_files:
        if not isinstance(raw, dict):
            continue
        relative = _clean_workspace_relative_path(raw.get("relativePath"))
        if not relative:
            continue
        if not (
            is_produced_file_path(relative)
            if produced_files
            else is_snapshotable_path(relative)
        ):
            continue
        title = (
            raw["title"]
            if isinstance(raw.get("title"), str) and raw["title"].strip()
            else PurePosixPath(relative).name
        )
        content: bytes | None = None
        skipped: str | None = None
        if not is_snapshotable_path(relative):
            # Never trust a daemon's storage decision: re-derive it here, so
            # bytes for a path outside the allowlist are dropped on arrival.
            skipped = "not-snapshotable-type"
        else:
            encoded = raw.get("contentBase64")
            if isinstance(encoded, str) and encoded:
                try:
                    decoded = base64.b64decode(encoded, validate=True)
                except (ValueError, TypeError):
                    decoded = None
                if (
                    decoded is not None
                    and len(decoded) <= WORKSPACE_ARTIFACT_CONTENT_MAX_BYTES
                ):
                    content = decoded
                else:
                    skipped = "too-large"
            else:
                reported = raw.get("snapshotSkipped")
                skipped = (
                    reported
                    if reported in SNAPSHOT_SKIPPED_REASONS
                    else "not-snapshotable-type"
                )
        content_type = raw.get("contentType")
        if not isinstance(content_type, str) or not content_type:
            content_type = mimetypes.guess_type(title)[0] or "application/octet-stream"
        items.append(
            {
                "path": str(Path(workspace_path) / relative)
                if workspace_path
                else relative,
                "relativePath": relative,
                "title": title,
                "bytes": _reported_file_size(raw, content),
                "contentType": content_type,
                "content": content,
                "snapshotSkipped": skipped,
            }
        )
        if len(items) >= GENERATED_ARTIFACT_LIMIT:
            break
    return items
```

Raise `GENERATED_ARTIFACT_LIMIT` from `20` to `200` so the backend does not re-truncate what the daemon already capped:

```python
GENERATED_ARTIFACT_LIMIT = 200
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run --project backend pytest backend/tests/unit/test_produced_files.py -v`
Expected: PASS, six tests.

- [ ] **Step 5: Commit**

```bash
git add backend/relay/daemon_registry/artifacts.py backend/tests/unit/test_produced_files.py
git commit -m "feat(backend): split produced-file candidacy from storage eligibility

The backend re-derives the storage decision from the path rather than
trusting the reporting daemon, so bytes for a non-allowlisted path are
discarded on arrival."
```

---

### Task 5: Delete the dead backend fallback walk

`_workspace_artifact_candidates` and its three public wrappers have no callers anywhere in the backend or its tests — `registry.py` sets `items = []` for daemons that report nothing. Removing them also retires the shared-filesystem assumption CLAUDE.md still documents.

**Files:**
- Modify: `backend/relay/daemon_registry/artifacts.py` (delete lines 40-66 constants and 95-189 functions), `CLAUDE.md` (one paragraph)
- Test: no new test; the deletion is proven by the existing suite staying green.

**Interfaces:**
- Consumes: nothing.
- Produces: removes `_workspace_artifact_candidates`, `workspace_generated_files`, `workspace_generated_file_snapshot`, `local_generated_file_item`, `GENERATED_ARTIFACT_EXCLUDED_DIRS`, `GENERATED_ARTIFACT_WALK_MAX_ENTRIES` from the module's surface.

- [ ] **Step 1: Prove they are unreferenced**

Run:

```bash
grep -rn "workspace_generated_files\|workspace_generated_file_snapshot\|local_generated_file_item\|_workspace_artifact_candidates\|GENERATED_ARTIFACT_EXCLUDED_DIRS\|GENERATED_ARTIFACT_WALK_MAX_ENTRIES" backend/ | grep -v "backend/relay/daemon_registry/artifacts.py"
```

Expected: no output. If anything prints, STOP — a caller appeared since this plan was written; report it rather than deleting.

- [ ] **Step 2: Delete the dead code**

From `backend/relay/daemon_registry/artifacts.py`, remove:
- the `GENERATED_ARTIFACT_EXCLUDED_DIRS` frozenset and the `GENERATED_ARTIFACT_WALK_MAX_ENTRIES` constant with its comment
- the functions `_workspace_artifact_candidates`, `workspace_generated_file_snapshot`, `workspace_generated_files`, and `local_generated_file_item`
- the now-unused imports: `os`, `stat`, and `logger` (verify `from loguru import logger` has no other use in the file before removing it), and `Path` only if nothing else uses it — `daemon_reported_generated_files` still does, so `Path` stays.

- [ ] **Step 3: Run the full backend suite**

Run: `uv run --project backend pytest backend/tests -q`
Expected: PASS, no collection errors and no import failures.

- [ ] **Step 4: Correct the architecture doc**

In `CLAUDE.md`, find the "Generated workspace artifacts are daemon-reported" bullet and replace the sentence beginning "for daemons without the capability it falls back to a bounded backend-side walk, which requires a shared filesystem" with:

```
A daemon that reports nothing indexes nothing: there is no backend-side
filesystem walk, so the backend never needs to share a filesystem with a
daemon. A daemon without the `produced-files` capability reports only
document types and is indexed under the older, narrower rule.
```

- [ ] **Step 5: Commit**

```bash
git add backend/relay/daemon_registry/artifacts.py CLAUDE.md
git commit -m "refactor(backend): delete the unreachable workspace artifact walk

registry.py has indexed nothing for daemons that report nothing since the
capability gate landed, leaving the walk and its bounds unreferenced. Its
removal also retires the shared-filesystem assumption in CLAUDE.md."
```

---

### Task 6: Registry records `snapshotSkipped` on the artifact

**Files:**
- Modify: `backend/relay/daemon_registry/registry.py:3381-3384` (capability-aware call) and `:3403-3416` (artifact dict)
- Test: `backend/tests/unit/test_daemon_registry.py` (append)

**Interfaces:**
- Consumes: `daemon_reported_generated_files(..., produced_files=...)` and its `snapshotSkipped` item field from Task 4; `DAEMON_CAPABILITY_PRODUCED_FILES` value `"produced-files"` from Task 1.
- Produces: artifact records with an optional `"snapshotSkipped"` key.

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/unit/test_daemon_registry.py`, following the file's existing run-completion fixture style:

```python
def test_run_completed_records_why_a_produced_file_was_not_snapshotted(tmp_path) -> None:
    """A file attributed to a run but never stored must say so on the record.

    Without the reason a reader cannot tell a live-only file from one that
    simply was not produced — the distinction the whole surface rests on.
    """
    registry, store, session_id, run_id = _registry_with_active_run(
        tmp_path, capabilities=["generated-files", "produced-files"]
    )
    registry.record_event(
        {
            "type": "run.completed",
            "sessionId": session_id,
            "runId": run_id,
            "generatedFiles": [
                {
                    "relativePath": "src/main.py",
                    "title": "main.py",
                    "bytes": 4096,
                    "contentType": "text/x-python",
                    "snapshotSkipped": "not-snapshotable-type",
                },
                {
                    "relativePath": "report.md",
                    "title": "report.md",
                    "bytes": 8,
                    "contentType": "text/markdown",
                    "contentBase64": base64.b64encode(b"# Report").decode("ascii"),
                },
            ],
        }
    )

    artifacts = {a["workspaceRelativePath"]: a for a in store.get_session(session_id)["artifacts"]}
    assert artifacts["src/main.py"]["snapshotSkipped"] == "not-snapshotable-type"
    assert "snapshotSkipped" not in artifacts["report.md"]


def test_a_daemon_without_produced_files_indexes_only_documents(tmp_path) -> None:
    registry, store, session_id, run_id = _registry_with_active_run(
        tmp_path, capabilities=["generated-files"]
    )
    registry.record_event(
        {
            "type": "run.completed",
            "sessionId": session_id,
            "runId": run_id,
            "generatedFiles": [
                {"relativePath": "src/main.py", "title": "main.py", "bytes": 4096, "contentType": "text/x-python"},
                {"relativePath": "report.md", "title": "report.md", "bytes": 8, "contentType": "text/markdown"},
            ],
        }
    )
    indexed = {a["workspaceRelativePath"] for a in store.get_session(session_id)["artifacts"]}
    assert indexed == {"report.md"}
```

Reuse the module's existing helper for building a registry with an active run; if it does not take a `capabilities` argument, extend it to pass the list through to the sandbox record rather than writing a second helper.

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run --project backend pytest backend/tests/unit/test_daemon_registry.py -k produced -v`
Expected: FAIL — `KeyError: 'snapshotSkipped'`, because the artifact dict does not carry it and `src/main.py` was never indexed.

- [ ] **Step 3: Write the implementation**

In `backend/relay/daemon_registry/registry.py`, import the capability constant name as a literal alongside the other capability constants used in this module, then make the report call capability-aware:

```python
        if isinstance(event.get("generatedFiles"), list):
            items = daemon_reported_generated_files(
                artifact_workspace_path,
                event["generatedFiles"],
                produced_files=DAEMON_CAPABILITY_PRODUCED_FILES
                in (sandbox.get("capabilities") or []),
            )
        else:
            # Older daemons must upgrade to report generated files; the backend
            # never walks a workspace itself.
            items = []
```

Add the constant next to the module's other capability literals:

```python
# Mirrors DAEMON_CAPABILITY_PRODUCED_FILES in relay-core's daemon-node-protocol.
DAEMON_CAPABILITY_PRODUCED_FILES = "produced-files"
```

And carry the reason onto the artifact dict, immediately after `"workspaceRelativePath"`:

```python
                "workspaceRelativePath": item["relativePath"],
                **(
                    {"snapshotSkipped": item["snapshotSkipped"]}
                    if item.get("snapshotSkipped")
                    else {}
                ),
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run --project backend pytest backend/tests/unit/test_daemon_registry.py -v`
Expected: PASS, including the pre-existing tests in the file.

- [ ] **Step 5: Commit**

```bash
git add backend/relay/daemon_registry/registry.py backend/tests/unit/test_daemon_registry.py
git commit -m "feat(backend): record why a produced file carries no snapshot"
```

---

### Task 7: `GET /tasks/{id}/files` merges the index with live listings

The endpoint that makes one surface possible. It must return produced files even when every live read fails — that is the whole point of index-first.

**Files:**
- Create: `backend/relay/services/produced_files.py`
- Modify: `backend/relay/api/task_routes.py` (append route; reuse `newest_artifacts_by_file`, `_task_workspace_target`, `_task_workspace_command`)
- Test: Create `backend/tests/api/test_task_files.py`

**Interfaces:**
- Consumes: artifact records with `workspaceRelativePath`, `bytes`, `createdAt`, and optional `snapshotSkipped` (Task 6).
- Produces: `file_currency(artifact: dict, listings: dict[str, dict[str, dict]]) -> str` returning one of `"current" | "changed-since" | "deleted" | "unknown"`; `listing_directories(artifacts: list[dict], *, root: str = "", limit: int = 8) -> list[str]` (keyword-only after the first argument); `live_status(error: HTTPException) -> str` returning one of `"offline" | "not-created" | "unsupported" | "denied" | "unavailable"`; `PRODUCED_FILE_LISTING_MAX_DIRS = 8`. Response shape `{"taskId", "produced": [...], "live": {"status", "path", "entries"}}`.

**Note on status vocabulary:** `_task_workspace_target` raises reasons in the daemon's vocabulary (`"workspace-not-created"`, `"computer-offline"`, `"workspace-unsupported"`) and a bare 403 for denial. Those strings must be normalised into the five-value union above before they reach the response, or the web types in Task 8 will not match. `live_status` is that seam.

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/api/test_task_files.py`, reusing the `_bootstrap`, `_create_task_with_session`, and `_workspace_artifact` helpers from `backend/tests/api/test_task_artifacts.py` (import them or copy them — this file follows the same fixture style):

```python
from __future__ import annotations

from tempfile import TemporaryDirectory

from fastapi.testclient import TestClient

from relay.app import create_app
from relay.persistence.stores import relay_event
from relay.services.produced_files import file_currency, listing_directories

from .test_task_artifacts import _bootstrap, _create_task_with_session, _workspace_artifact


def test_currency_compares_the_record_against_the_live_entry() -> None:
    artifact = {"workspaceRelativePath": "report.md", "bytes": 8, "createdAt": "2026-07-01T00:00:00.000Z"}
    listings = {"": {"report.md": {"bytes": 8, "updatedAt": "2026-07-01T00:00:00.000Z"}}}
    assert file_currency(artifact, listings) == "current"

    listings = {"": {"report.md": {"bytes": 99, "updatedAt": "2026-07-01T00:00:00.000Z"}}}
    assert file_currency(artifact, listings) == "changed-since"

    listings = {"": {"report.md": {"bytes": 8, "updatedAt": "2026-07-09T00:00:00.000Z"}}}
    assert file_currency(artifact, listings) == "changed-since"

    assert file_currency(artifact, {"": {}}) == "deleted"
    # No listing covers this file's directory at all.
    assert file_currency(artifact, {}) == "unknown"


def test_live_status_normalises_daemon_reasons_into_the_client_vocabulary() -> None:
    from fastapi import HTTPException

    from relay.services.produced_files import live_status

    assert live_status(HTTPException(409, {"reason": "workspace-not-created"})) == "not-created"
    assert live_status(HTTPException(503, {"reason": "computer-offline"})) == "offline"
    assert live_status(HTTPException(503, {"reason": "workspace-unsupported"})) == "unsupported"
    assert live_status(HTTPException(403, "nope")) == "denied"
    # An unrecognised failure must not invent a reason it cannot prove.
    assert live_status(HTTPException(502, "something else")) == "unavailable"


def test_listing_directories_covers_the_root_and_caps_the_rest() -> None:
    artifacts = [{"workspaceRelativePath": f"pkg{i}/mod.py"} for i in range(12)]
    dirs = listing_directories(artifacts, root="", limit=8)
    assert dirs[0] == ""
    assert len(dirs) == 8
    assert len(set(dirs)) == 8


def test_task_files_returns_produced_records_when_the_computer_is_down(monkeypatch) -> None:
    """Index-first: an offline computer must not empty the surface."""
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root, TemporaryDirectory() as ws:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap(client)
        task = _create_task_with_session(client, ws)
        session_id = task["linkedSessionIds"][0]
        report = _workspace_artifact(
            ws, "report.md",
            artifact_id="20000000-0000-4000-8000-000000000001",
            created_at="2026-07-01T00:00:00.000Z",
            content_type="text/markdown",
        )
        app.state.session_store.append_event(
            session_id, relay_event("artifact.created", session_id, {"artifact": report})
        )

        # No daemon is registered, so every live read fails.
        response = client.get(f"/api/v1/tasks/{task['id']}/files")
        assert response.status_code == 200, response.text
        body = response.json()
        assert [item["title"] for item in body["produced"]] == ["report.md"]
        assert body["produced"][0]["currency"] == "unknown"
        assert body["live"]["status"] != "ok"
        assert body["live"]["entries"] == []


def test_task_files_reports_the_snapshot_reason_on_a_live_only_row(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root, TemporaryDirectory() as ws:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap(client)
        task = _create_task_with_session(client, ws)
        session_id = task["linkedSessionIds"][0]
        source = {
            **_workspace_artifact(
                ws, "main.py",
                artifact_id="20000000-0000-4000-8000-000000000002",
                created_at="2026-07-02T00:00:00.000Z",
                content_type="text/x-python",
            ),
            "workspaceRelativePath": "src/main.py",
            "snapshotSkipped": "not-snapshotable-type",
        }
        app.state.session_store.append_event(
            session_id, relay_event("artifact.created", session_id, {"artifact": source})
        )

        body = client.get(f"/api/v1/tasks/{task['id']}/files").json()
        assert body["produced"][0]["snapshotSkipped"] == "not-snapshotable-type"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run --project backend pytest backend/tests/api/test_task_files.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'relay.services.produced_files'`

- [ ] **Step 3: Write the pure helpers**

Create `backend/relay/services/produced_files.py`:

```python
"""Resolve a produced file's currency against live workspace listings.

A live listing covers one directory, but produced files nest. The route
gathers a bounded set of listings and this module answers, per file, whether
the bytes on disk still match the record. Anything outside the gathered set
answers "unknown" rather than guessing — a wrong "current" is worse than an
honest absence of information.
"""

from __future__ import annotations

from posixpath import dirname
from typing import Any

from fastapi import HTTPException

PRODUCED_FILE_LISTING_MAX_DIRS = 8

# The daemon reports failures in its own vocabulary; clients get a stable five.
LIVE_STATUS_BY_REASON = {
    "workspace-not-created": "not-created",
    "computer-offline": "offline",
    "workspace-unsupported": "unsupported",
}


def live_status(error: HTTPException) -> str:
    """Why the live directory could not be read, in the client's vocabulary.

    Falls back to "unavailable" rather than guessing: a status the reader
    cannot act on is better than a specific one that is wrong.
    """
    if error.status_code == 403:
        return "denied"
    detail = error.detail if isinstance(error.detail, dict) else {}
    reason = detail.get("reason") or detail.get("code")
    return LIVE_STATUS_BY_REASON.get(reason, "unavailable")

CURRENCY_CURRENT = "current"
CURRENCY_CHANGED = "changed-since"
CURRENCY_DELETED = "deleted"
CURRENCY_UNKNOWN = "unknown"


def listing_directories(
    artifacts: list[dict[str, Any]], *, root: str = "", limit: int = PRODUCED_FILE_LISTING_MAX_DIRS
) -> list[str]:
    """Directories worth listing: the root, then the busiest parents, capped.

    Ordered by how many produced files each directory holds so the cap spends
    its budget where it resolves the most rows.
    """
    counts: dict[str, int] = {}
    for artifact in artifacts:
        relative = artifact.get("workspaceRelativePath")
        if not isinstance(relative, str) or not relative:
            continue
        counts[dirname(relative)] = counts.get(dirname(relative), 0) + 1
    ranked = sorted(counts.items(), key=lambda item: (-item[1], item[0]))
    directories = [root]
    for directory, _count in ranked:
        if len(directories) >= limit:
            break
        if directory not in directories:
            directories.append(directory)
    return directories


def file_currency(
    artifact: dict[str, Any], listings: dict[str, dict[str, dict[str, Any]]]
) -> str:
    """Whether the workspace copy still matches this record.

    ``listings`` maps a directory path to its entries by *file name*.
    """
    relative = artifact.get("workspaceRelativePath")
    if not isinstance(relative, str) or not relative:
        return CURRENCY_UNKNOWN
    directory = dirname(relative)
    entries = listings.get(directory)
    if entries is None:
        return CURRENCY_UNKNOWN
    entry = entries.get(relative.rsplit("/", 1)[-1])
    if entry is None:
        return CURRENCY_DELETED
    if entry.get("bytes") != artifact.get("bytes"):
        return CURRENCY_CHANGED
    updated_at = entry.get("updatedAt") or ""
    created_at = artifact.get("createdAt") or ""
    return CURRENCY_CHANGED if updated_at > created_at else CURRENCY_CURRENT
```

- [ ] **Step 4: Write the route**

Append to `backend/relay/api/task_routes.py`, after `task_artifacts`:

```python
async def _task_directory_listings(
    ctx: AppContext, task: dict[str, Any], actor: dict[str, Any], directories: list[str]
) -> tuple[dict[str, dict[str, dict[str, Any]]], dict[str, Any]]:
    """Live listings for the given directories, and why they are missing.

    Never raises: an unreachable computer degrades the surface to the index
    rather than failing the request, which is what index-first means.
    """
    try:
        node, layout, subpath = _task_workspace_target(ctx, task, actor)
    except HTTPException as error:
        return {}, {"status": live_status(error), "entries": [], "path": directories[0]}

    # Three outcomes per directory, and they must stay distinct: the read
    # succeeded, the directory is simply not there yet, or the read failed.
    async def _one(path: str) -> tuple[str, list[dict[str, Any]] | None, str | None]:
        try:
            event = await dispatch_workspace_command(
                ctx,
                node,
                _task_workspace_command(
                    task,
                    command_id=new_database_id(),
                    command_type="workspace.list",
                    path=path,
                    workspace_layout=layout,
                    workspace_subpath=subpath,
                ),
            )
            raise_workspace_error(event)
        except HTTPException as error:
            return path, None, live_status(error)
        if not event.get("exists"):
            return path, None, "not-created"
        return path, event.get("entries") or [], None

    results = await asyncio.gather(*(_one(path) for path in directories))
    listings: dict[str, dict[str, dict[str, Any]]] = {}
    root_entries: list[dict[str, Any]] = []
    root_failure: str | None = None
    for path, entries, failure in results:
        if path == directories[0]:
            root_failure = failure
        if entries is None:
            continue
        listings[path] = {entry["name"]: entry for entry in entries}
        if path == directories[0]:
            root_entries = entries
    if root_failure:
        return listings, {"status": root_failure, "entries": [], "path": directories[0]}
    return listings, {"status": "ok", "entries": root_entries, "path": directories[0]}


@router.get("/tasks/{task_id}/files")
async def task_files(
    task_id: str, request: Request, ctx: AppContextDep
) -> dict[str, Any]:
    """Every file this task produced, with what is on disk right now.

    The produced index is the spine: it renders whether or not the computer is
    reachable. A live listing enriches each row with currency and contributes
    the directory entries no run produced.
    """
    actor = request_actor(request, ctx.auth_store)
    task = get_task_for_actor(ctx.task_store, task_id, actor)
    sources: list[tuple[str, str]] = [
        (task_id, session_id) for session_id in task.get("linkedSessionIds", [])
    ]
    for occurrence in occurrence_tasks(ctx, task, actor):
        sources.extend(
            (occurrence["id"], session_id)
            for session_id in occurrence.get("linkedSessionIds", [])
        )
    produced = sorted(
        newest_artifacts_by_file(
            ctx, sources, all_versions=request.query_params.get("versions") == "all"
        ).values(),
        key=lambda item: item.get("createdAt") or "",
        reverse=True,
    )
    root = workspace_path(request.query_params.get("path"))
    listings, live = await _task_directory_listings(
        ctx, task, actor, listing_directories(produced, root=root)
    )
    claimed = {item.get("workspaceRelativePath") for item in produced}
    return {
        "taskId": task_id,
        "produced": [
            {**item, "currency": file_currency(item, listings)} for item in produced
        ],
        "live": {
            **live,
            "entries": [
                entry for entry in live["entries"] if entry.get("path") not in claimed
            ],
        },
    }
```

Add the imports this route needs to the top of `task_routes.py`: `import asyncio`, `from fastapi import HTTPException`, and `from ..services.produced_files import file_currency, listing_directories, live_status`. Verify `AppContext` is already imported for the helper's annotation; if only `AppContextDep` is, import `AppContext` alongside it.

- [ ] **Step 5: Run tests to verify they pass**

Run: `uv run --project backend pytest backend/tests/api/test_task_files.py -v`
Expected: PASS, four tests.

- [ ] **Step 6: Run the whole backend suite**

Run: `uv run --project backend pytest backend/tests -q`
Expected: PASS — in particular `test_task_artifacts.py` and `test_task_workspace_routes.py`, which cover the routes this one sits beside and must not disturb.

- [ ] **Step 7: Commit**

```bash
git add backend/relay/services/produced_files.py backend/relay/api/task_routes.py backend/tests/api/test_task_files.py
git commit -m "feat(backend): serve produced files merged with live workspace state

One endpoint answers what a task produced, whether each file is still on
disk, and what else sits in the directory. It degrades to the index when
the computer is unreachable instead of failing."
```

---

### Task 8: Web types and API client for the files endpoint

**Files:**
- Modify: `web/src/types.ts` (append near `TaskArtifactsResponse`, line ~112), `web/src/api.ts` (append near `listTaskArtifacts`, line ~671)
- Test: `web/tests/api.test.ts` (append)

**Interfaces:**
- Consumes: the Task 7 response shape.
- Produces: `ProducedFileCurrency`, `SnapshotSkippedReason`, `ProducedFile`, `TaskLiveStatus`, `TaskFilesResponse`; `listTaskFiles(input: { taskId: string; path?: string; allVersions?: boolean }, signal?: AbortSignal): Promise<TaskFilesResponse>`.

- [ ] **Step 1: Write the failing test**

Append to `web/tests/api.test.ts`, following the file's existing fetch-stub style:

```typescript
test("listTaskFiles requests the merged surface with paging and version options", async () => {
  const calls: string[] = [];
  const restore = stubFetch(calls, { taskId: "t1", produced: [], live: { status: "ok", path: "", entries: [] } });
  try {
    const { listTaskFiles } = await import("../src/api");
    await listTaskFiles({ taskId: "t 1", path: "src", allVersions: true });
    assert.equal(calls.length, 1);
    assert.ok(calls[0].includes("/tasks/t%201/files"), calls[0]);
    assert.ok(calls[0].includes("path=src"), calls[0]);
    assert.ok(calls[0].includes("versions=all"), calls[0]);
  } finally {
    restore();
  }
});
```

Reuse the module's existing fetch-stub helper rather than adding another; if it is named differently, match it.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx tsx --test tests/api.test.ts`
Expected: FAIL — `listTaskFiles is not a function`.

- [ ] **Step 3: Write the implementation**

In `web/src/types.ts`, after `TaskArtifactsResponse`:

```typescript
/** Whether the workspace copy still matches the produced record. */
export type ProducedFileCurrency = "current" | "changed-since" | "deleted" | "unknown";

/** Why a produced file carries no stored snapshot. */
export type SnapshotSkippedReason =
  | "too-large"
  | "not-snapshotable-type"
  | "sensitive"
  | "unreadable";

/**
 * One file a run of this task created or modified.
 *
 * Durability (`snapshotSkipped`) and currency are independent: a file can be
 * stored and stale, or current and never stored.
 */
export interface ProducedFile extends ArtifactIndexItem {
  currency: ProducedFileCurrency;
  snapshotSkipped?: SnapshotSkippedReason;
}

export type TaskLiveStatus =
  | "ok"
  | "offline"
  | "not-created"
  | "unsupported"
  | "denied"
  | "unavailable";

export interface TaskFilesResponse {
  taskId: string;
  produced: ProducedFile[];
  live: {
    status: TaskLiveStatus;
    path: string;
    entries: WorkspaceFileEntry[];
  };
}
```

In `web/src/api.ts`, beside `listTaskArtifacts`:

```typescript
/**
 * A task's produced files, plus whatever else is in the directory right now.
 *
 * Resolves even when the computer is unreachable: `live.status` says why the
 * directory is missing while `produced` still lists what the task made.
 */
export function listTaskFiles(
  input: { taskId: string; path?: string; allVersions?: boolean },
  signal?: AbortSignal,
): Promise<TaskFilesResponse> {
  const params = new URLSearchParams();
  if (input.path) params.set("path", input.path);
  if (input.allVersions) params.set("versions", "all");
  const query = params.toString();
  return apiJson<TaskFilesResponse>(
    `/tasks/${encodeURIComponent(input.taskId)}/files${query ? `?${query}` : ""}`,
    { signal },
  );
}
```

Add `TaskFilesResponse` to the existing type import block at the top of `api.ts`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npx tsx --test tests/api.test.ts && npx tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add web/src/types.ts web/src/api.ts web/tests/api.test.ts
git commit -m "feat(web): type and fetch the merged task files surface"
```

---

### Task 9: `producedFileRows` — the tiering decision, testable without React

Extracted from the component for the same reason `taskWorkspaceState` was: "the computer is offline" and "the task produced nothing" must never be conflated, and that is worth proving without mounting React.

**Files:**
- Create: `web/src/components/task-board/producedFileRows.ts`
- Test: Create `web/tests/producedFiles.test.ts`

**Interfaces:**
- Consumes: `ProducedFile`, `WorkspaceFileEntry`, `TaskLiveStatus` from Task 8.
- Produces: `secondaryTierEntries(produced: ProducedFile[], entries: WorkspaceFileEntry[]): WorkspaceFileEntry[]`; `producedFilesState(query: { isLoading: boolean; error: unknown; data: TaskFilesResponse | undefined }): ProducedFilesState` where `ProducedFilesState = "loading" | "failed" | "empty" | "ready"`; `durabilityTone(file: ProducedFile): "stored" | "live-only"`.

- [ ] **Step 1: Write the failing tests**

Create `web/tests/producedFiles.test.ts`:

```typescript
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  durabilityTone,
  producedFilesState,
  secondaryTierEntries,
} from "../src/components/task-board/producedFileRows";
import type { ProducedFile, TaskFilesResponse, WorkspaceFileEntry } from "../src/types";

function producedFile(path: string, extra: Partial<ProducedFile> = {}): ProducedFile {
  return {
    id: path,
    kind: "workspace_file",
    title: path.split("/").at(-1) as string,
    sessionId: "s1",
    workspaceRelativePath: path,
    currency: "current",
    ...extra,
  } as ProducedFile;
}

function entry(path: string): WorkspaceFileEntry {
  return { name: path.split("/").at(-1) as string, path, kind: "file", updatedAt: "2026-07-01T00:00:00.000Z" };
}

describe("producedFileRows", () => {
  it("keeps a file out of the second tier once a run claims it", () => {
    const produced = [producedFile("report.md")];
    const live = [entry("report.md"), entry("main.py"), entry(".gitignore")];
    assert.deepEqual(
      secondaryTierEntries(produced, live).map((item) => item.path),
      ["main.py", ".gitignore"],
    );
  });

  it("distinguishes an unreachable computer from a task that produced nothing", () => {
    const offline: TaskFilesResponse = {
      taskId: "t1",
      produced: [producedFile("report.md")],
      live: { status: "offline", path: "", entries: [] },
    };
    // Produced rows exist, so the surface is ready even with no live read.
    assert.equal(producedFilesState({ isLoading: false, error: null, data: offline }), "ready");

    const nothing: TaskFilesResponse = {
      taskId: "t1",
      produced: [],
      live: { status: "ok", path: "", entries: [] },
    };
    assert.equal(producedFilesState({ isLoading: false, error: null, data: nothing }), "empty");

    assert.equal(producedFilesState({ isLoading: true, error: null, data: undefined }), "loading");
    assert.equal(producedFilesState({ isLoading: false, error: new Error("nope"), data: undefined }), "failed");
  });

  it("reads durability off the snapshot reason, not off the file type", () => {
    assert.equal(durabilityTone(producedFile("report.md")), "stored");
    assert.equal(
      durabilityTone(producedFile("src/main.py", { snapshotSkipped: "not-snapshotable-type" })),
      "live-only",
    );
    assert.equal(
      durabilityTone(producedFile("bundle.zip", { snapshotSkipped: "too-large" })),
      "live-only",
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && npx tsx --test tests/producedFiles.test.ts`
Expected: FAIL — cannot find module `producedFileRows`.

- [ ] **Step 3: Write the implementation**

Create `web/src/components/task-board/producedFileRows.ts`:

```typescript
import type { ProducedFile, TaskFilesResponse, WorkspaceFileEntry } from "../../types";

/** Whether the surface has anything to render, and why not when it does not.
 *
 *  "the computer is offline" and "the task produced nothing" look the same to
 *  a careless reader and must not be conflated: an offline computer still has
 *  produced rows to show, so it is `ready`, not `empty`. */
export type ProducedFilesState = "loading" | "failed" | "empty" | "ready";

export function producedFilesState(query: {
  isLoading: boolean;
  error: unknown;
  data: TaskFilesResponse | undefined;
}): ProducedFilesState {
  if (query.isLoading) return "loading";
  if (query.error || !query.data) return "failed";
  if (query.data.produced.length === 0 && query.data.live.entries.length === 0) return "empty";
  return "ready";
}

/** Live entries no run claimed, so a file never appears in both tiers. */
export function secondaryTierEntries(
  produced: ProducedFile[],
  entries: WorkspaceFileEntry[],
): WorkspaceFileEntry[] {
  const claimed = new Set(
    produced.map((file) => file.workspaceRelativePath).filter((path): path is string => Boolean(path)),
  );
  return entries.filter((entry) => !claimed.has(entry.path));
}

/** Durability is a property of the record, never inferred from the name. */
export function durabilityTone(file: ProducedFile): "stored" | "live-only" {
  return file.snapshotSkipped ? "live-only" : "stored";
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd web && npx tsx --test tests/producedFiles.test.ts`
Expected: PASS, three tests.

- [ ] **Step 5: Commit**

```bash
git add web/src/components/task-board/producedFileRows.ts web/tests/producedFiles.test.ts
git commit -m "feat(web): decide produced-file tiering outside React

An offline computer still has produced rows, so it must read as ready and
not as an empty task. Worth proving without mounting a component."
```

---

### Task 10: `TaskDrawerFiles` replaces both sections

**Files:**
- Create: `web/src/components/task-board/TaskDrawerFiles.tsx`
- Delete: `web/src/components/task-board/TaskDrawerArtifacts.tsx`, `web/src/components/task-board/TaskDrawerWorkspace.tsx`, `web/src/components/task-board/taskWorkspaceState.ts`
- Modify: `web/src/components/task-board/TaskDrawer.tsx:35-37, 665-686`, `web/src/i18n/locales/{en,zh-CN,zh-TW}/translation.json`
- Test: `web/tests/producedFiles.test.ts` (extend), and delete `web/tests/` cases that import `taskWorkspaceState`

**Interfaces:**
- Consumes: `listTaskFiles` (Task 8); `producedFilesState`, `secondaryTierEntries`, `durabilityTone` (Task 9).
- Produces: `<TaskDrawerFiles taskId onOpenThread />`.

- [ ] **Step 1: Check what the deletion breaks**

Run:

```bash
grep -rn "taskWorkspaceState\|TaskDrawerArtifacts\|TaskDrawerWorkspace" web/src web/tests
```

Expected: references in `TaskDrawer.tsx` and possibly a `web/tests/*.test.ts` covering `taskWorkspaceState`. Note each one; every hit must be resolved by the end of this task.

- [ ] **Step 2: Add the i18n keys**

In `web/src/i18n/locales/en/translation.json`, under `backlog`, add:

```json
    "files": "Files",
    "files_loading": "Loading files…",
    "files_error": "Files could not be loaded.",
    "files_empty": "This task hasn't produced any files yet.",
    "files_refresh": "Refresh",
    "files_versions": "Show every version",
    "files_latest": "Show latest only",
    "files_download": "Download",
    "files_stored": "Saved",
    "files_live_only": "Live only",
    "files_skipped_too_large": "Too large to save",
    "files_skipped_not_snapshotable_type": "Not saved for this file type",
    "files_skipped_sensitive": "Not saved: may contain a credential",
    "files_skipped_unreadable": "Not saved: file was unreadable",
    "files_currency_current": "Current",
    "files_currency_changed_since": "Changed since this run",
    "files_currency_deleted": "No longer in the workspace",
    "files_currency_unknown": "Current state unknown",
    "files_directory": "Also in this directory",
    "files_live_offline": "This Computer is offline, so the directory can't be read. Files produced by past runs are listed above.",
    "files_live_not_created": "This task hasn't created a workspace yet.",
    "files_live_unsupported": "This Computer needs a daemon upgrade to browse workspaces.",
    "files_live_denied": "You don't have access to this workspace.",
    "files_live_unavailable": "This task's workspace can't be reached right now.",
```

Add the same keys to `zh-CN` and `zh-TW` translation files with translated values, matching how the existing `backlog.workspace_*` keys are translated there. Remove the now-unused `backlog.artifacts*` and `backlog.workspace*` keys from all three files — but only those referenced solely by the two deleted components. `grep -rn "backlog.workspace_shared_project\|backlog.artifacts" web/src` before removing each, since `ThreadSpacePanel` and the artifact drawer may share some.

- [ ] **Step 3: Write the component**

Create `web/src/components/task-board/TaskDrawerFiles.tsx`:

```tsx
"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { listTaskFiles, taskWorkspaceStatus } from "../../api";
import { artifactRawHref } from "../../lib/artifactPreview";
import { useArtifactViewer } from "../ArtifactViewerProvider";
import type { ProducedFile, TaskFilesResponse } from "../../types";
import { WorkspaceFileList, WorkspacePathBreadcrumb } from "../workspace/WorkspaceFileList";
import { Button } from "@/components/ui/button";
import { durabilityTone, producedFilesState, secondaryTierEntries } from "./producedFileRows";

function fileDate(value: string | undefined, locale: string): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(locale || undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

/**
 * Every file a run of this task produced, and what is in the directory now.
 *
 * The produced index is the spine — it renders whether or not the Computer is
 * reachable — because "what did this task make" is the question a task record
 * exists to answer. The live listing enriches each row with currency and
 * contributes, in a second tier, the files no run produced.
 *
 * A routine's rows come from its occurrences and need no special case here:
 * the backend rolls them up, and the second tier at a routine's root is the
 * list of its occurrence directories.
 */
export function TaskDrawerFiles({
  taskId,
  onOpenThread,
}: {
  taskId: string;
  onOpenThread?: (sessionId: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const { open } = useArtifactViewer();
  const [path, setPath] = useState("");
  const [allVersions, setAllVersions] = useState(false);
  const [showDirectory, setShowDirectory] = useState(false);

  const filesQuery = useQuery({
    queryKey: ["task-files", taskId, path, allVersions],
    retry: false,
    queryFn: ({ signal }): Promise<TaskFilesResponse> =>
      listTaskFiles({ taskId, path, allVersions }, signal),
  });
  const statusQuery = useQuery({
    queryKey: ["task-workspace-status", taskId],
    queryFn: ({ signal }) => taskWorkspaceStatus(taskId, signal),
    refetchInterval: 3000,
    retry: false,
  });

  const state = producedFilesState({
    isLoading: filesQuery.isLoading,
    error: filesQuery.error,
    data: filesQuery.data,
  });
  const produced = filesQuery.data?.produced ?? [];
  const live = filesQuery.data?.live;
  const directoryEntries = live ? secondaryTierEntries(produced, live.entries) : [];

  function durabilityLabel(file: ProducedFile): string {
    if (!file.snapshotSkipped) return t("backlog.files_stored");
    return t(`backlog.files_skipped_${file.snapshotSkipped.replace(/-/g, "_")}`);
  }

  return (
    <section className="task-drawer-artifacts" aria-label={t("backlog.files")}>
      <h3 className="task-drawer-artifacts-title">
        {t("backlog.files")}
        {produced.length > 0 ? (
          <span className="task-drawer-artifacts-count tnum">{produced.length}</span>
        ) : null}
      </h3>
      <Button variant="ghost" type="button" onClick={() => void filesQuery.refetch()}>
        {t("backlog.files_refresh")}
      </Button>
      <Button
        variant="ghost"
        type="button"
        aria-pressed={allVersions}
        onClick={() => setAllVersions(!allVersions)}
      >
        {t(allVersions ? "backlog.files_latest" : "backlog.files_versions")}
      </Button>

      {statusQuery.data?.waiting ? (
        <p className="task-drawer-artifacts-empty" role="status">
          {t("backlog.workspace_waiting")}{" "}
          {statusQuery.data.blockingSessionId ? (
            <a
              href={`/threads/${encodeURIComponent(statusQuery.data.blockingSessionId)}`}
              onClick={(event) => {
                if (onOpenThread && statusQuery.data?.blockingSessionId) {
                  event.preventDefault();
                  onOpenThread(statusQuery.data.blockingSessionId);
                }
              }}
            >
              {statusQuery.data.blockingTitle || t("backlog.workspace_open_active")}
            </a>
          ) : null}
        </p>
      ) : null}

      {state === "loading" ? (
        <p className="task-drawer-artifacts-empty" role="status" aria-live="polite">
          {t("backlog.files_loading")}
        </p>
      ) : state === "failed" ? (
        <p className="task-drawer-artifacts-empty" role="alert">{t("backlog.files_error")}</p>
      ) : state === "empty" ? (
        <p className="task-drawer-artifacts-empty">{t("backlog.files_empty")}</p>
      ) : (
        <>
          <ul className="task-drawer-artifact-list">
            {produced.map((file) => (
              <li key={file.id} className="task-drawer-artifact">
                <Button
                  variant="ghost"
                  type="button"
                  className="task-drawer-artifact-main"
                  // Opened over TaskDrawer — declare the stack layer explicitly
                  // so its backdrop z-index clears the drawer beneath it.
                  onClick={() => open(file, file.sessionId, produced, 1)}
                  disabled={Boolean(file.snapshotSkipped) && file.currency !== "current"}
                  title={t("artifact.view_named", { title: file.title })}
                >
                  <span className={`artifact-kind-tag is-${file.kind}`}>
                    {t(`artifact.kind.${file.kind}`, { defaultValue: file.kind })}
                  </span>
                  <span className="task-drawer-artifact-name">
                    {file.workspaceRelativePath || file.title}
                  </span>
                  <span className={`produced-file-durability is-${durabilityTone(file)}`}>
                    {durabilityLabel(file)}
                  </span>
                  <span className={`produced-file-currency is-${file.currency}`}>
                    {t(`backlog.files_currency_${file.currency.replace(/-/g, "_")}`)}
                  </span>
                  <span className="task-drawer-artifact-meta tnum">
                    {fileDate(file.createdAt, i18n.language)}
                  </span>
                </Button>
                {file.snapshotSkipped ? null : (
                  <a
                    className="task-drawer-artifact-download"
                    href={artifactRawHref(file.sessionId, file.id)}
                    target="_blank"
                    rel="noreferrer"
                    download={file.title}
                  >
                    {t("backlog.files_download")}
                  </a>
                )}
              </li>
            ))}
          </ul>

          {live && live.status !== "ok" ? (
            <p className="task-drawer-artifacts-empty" role="status">
              {t(`backlog.files_live_${live.status.replace(/-/g, "_")}`)}
            </p>
          ) : directoryEntries.length > 0 ? (
            <>
              <Button
                variant="ghost"
                type="button"
                aria-expanded={showDirectory}
                onClick={() => setShowDirectory(!showDirectory)}
              >
                {t("backlog.files_directory")}
                <span className="task-drawer-artifacts-count tnum">{directoryEntries.length}</span>
              </Button>
              {showDirectory ? (
                <div className="thread-space-files">
                  <div className="thread-space-files-bar">
                    <WorkspacePathBreadcrumb path={path} onNavigate={setPath} />
                  </div>
                  <div className="thread-space-files-body">
                    <WorkspaceFileList
                      data={{ ...live, entries: directoryEntries, exists: true }}
                      error={null}
                      isLoading={false}
                      path={path}
                      selectedPath=""
                      onOpenDirectory={setPath}
                      onSelectFile={(entry) => setPath(entry.path)}
                      onRetry={() => void filesQuery.refetch()}
                    />
                  </div>
                </div>
              ) : null}
            </>
          ) : null}
        </>
      )}
    </section>
  );
}
```

If `WorkspaceFileList`'s `data` prop type does not accept the object literal above, widen the call by constructing a `TaskWorkspaceFilesResponse`-shaped value with the fields it reads — do not change `WorkspaceFileList`, which `ProjectWorkspaceFiles` and `ThreadSpaceFiles` also use.

- [ ] **Step 4: Add the two new style hooks**

The component introduces `produced-file-durability` and `produced-file-currency`. Add them to the stylesheet that already defines `task-drawer-artifact-name` and `artifact-kind-tag` (find it with `grep -rn "task-drawer-artifact-name" web/src --include=*.css`). Use existing palette tokens only — `web/src/styles/palette.css` is the sole source of color, and stylelint enforces it:

```css
.produced-file-durability,
.produced-file-currency {
  font-size: var(--type-body-sm);
  color: var(--text-muted);
}

.produced-file-durability.is-live-only,
.produced-file-currency.is-changed-since,
.produced-file-currency.is-deleted {
  color: var(--text-warning);
}
```

If `--text-warning` is not defined in `palette.css`, use the nearest defined token rather than adding one; check with `grep -n "warning\|caution" web/src/styles/palette.css`.

- [ ] **Step 5: Wire it into the drawer and delete the old components**

In `web/src/components/task-board/TaskDrawer.tsx`, replace the two imports at lines 35-36 with:

```typescript
import { TaskDrawerFiles } from "./TaskDrawerFiles";
```

and replace the two rendered sections (lines 674-677, both the components and the comments between them) with:

```tsx
            {/* One surface: the produced index is the record of what ran, the
                live directory says what is there now, and each row carries
                both. Routines roll up from their occurrences the same way. */}
            <TaskDrawerFiles taskId={form.id} onOpenThread={onOpenThread} />
```

Then delete the three superseded files:

```bash
git rm web/src/components/task-board/TaskDrawerArtifacts.tsx \
       web/src/components/task-board/TaskDrawerWorkspace.tsx \
       web/src/components/task-board/taskWorkspaceState.ts
```

Delete any test file found in Step 1 that imports `taskWorkspaceState`; its coverage is replaced by `producedFilesState` in `web/tests/producedFiles.test.ts`.

- [ ] **Step 6: Verify nothing dangles**

Run:

```bash
grep -rn "taskWorkspaceState\|TaskDrawerArtifacts\|TaskDrawerWorkspace\|listTaskArtifacts" web/src web/tests
cd web && npx tsc --noEmit && npx stylelint "src/**/*.css"
```

Expected: no grep output, no type errors, no stylelint errors. `listTaskArtifacts` may remain in `api.ts` only if another surface still calls it; if the grep shows it is now unused, delete it from `api.ts` too.

- [ ] **Step 7: Run every web test**

Run: `cd web && npx tsx --test tests/*.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add -A web/
git commit -m "feat(web): one Files surface for a task's produced and live files

Artifacts and Workspace listed the same files filtered differently, with
no way to tell that they were one file. They are one section now, where
durability and currency are properties of a row."
```

---

### Task 11: Full-suite verification

**Files:**
- Modify: `CLAUDE.md` (testing section), if the new test files warrant a mention

- [ ] **Step 1: Run everything**

Run: `npm test`
Expected: PASS — the TypeScript suite and the Python backend suite.

- [ ] **Step 2: Update the architecture doc's testing list**

In `CLAUDE.md`, add to the Testing section's bullet list:

```
- `backend/tests/api/test_task_files.py`, `backend/tests/unit/test_produced_files.py` — produced-file candidacy vs storage eligibility, and the merged files endpoint degrading to the index when a Computer is unreachable.
- `web/tests/producedFiles.test.ts` — produced/live tiering and the offline-vs-empty distinction.
```

Also update the "Generated workspace artifacts are daemon-reported" invariant to state the candidacy/storage split, since that bullet currently describes the extension allowlist as deciding what gets indexed.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: record the produced-file candidacy and storage split"
```

---

## Self-Review Notes

**Spec coverage.** Every section of `docs/task-produced-files-design.md` maps to a task: the model's three fields to Tasks 1, 6, and 7; the surface to Task 10; routines to Task 10 (no special case, by design); daemon changes to Tasks 2 and 3; backend changes to Tasks 4, 5, and 7; testing to the test steps throughout plus Task 11.

**Known gap carried from the spec.** Currency resolves only for produced files inside the eight directories the endpoint lists. A task whose output spans more than eight directories shows `unknown` on the overflow. Task 7's `listing_directories` spends the cap on the busiest directories first to minimise that.

**Deferred deliberately.** `TaskDrawer` is still a single scrolling edit form with four read panes inside it; `GET /tasks/{id}/artifacts` and `/workspace/files` remain mounted for compatibility even though the web app stops calling them. Both are named as out of scope in the spec.
