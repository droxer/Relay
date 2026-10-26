import { lstat, readFile, readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";

import type { DaemonGeneratedFile } from "relay-core";

import { THREAD_RECORDS_DIR, THREAD_RECORDS_DIRS } from "./thread-workspace.js";

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

const GENERATED_FILE_EXTENSIONS = new Set([
  ".csv",
  ".doc",
  ".docx",
  ".gif",
  ".html",
  ".jpeg",
  ".jpg",
  ".pdf",
  ".png",
  ".ppt",
  ".pptx",
  ".svg",
  ".tsv",
  ".webp",
  ".xls",
  ".xlsx",
]);

const OUTPUT_FILE_TEXT_EXTENSIONS = new Set([
  ".json",
  ".log",
  ".md",
  ".txt",
]);

const GENERATED_FILE_EXCLUDED_DIRS = new Set([
  ".cache",
  ".git",
  ".gradle",
  ".mypy_cache",
  ".next",
  ".oci",
  ".pytest_cache",
  ".relay",
  ".ruff_cache",
  ".tox",
  ".turbo",
  ".venv",
  "__pycache__",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "target",
  "venv",
]);

/** Dependency lockfiles churn on every install and are never a deliverable. */
const GENERATED_FILE_EXCLUDED_NAMES = new Set([
  "Cargo.lock",
  "go.sum",
  "package-lock.json",
  "pnpm-lock.yaml",
  "poetry.lock",
  "uv.lock",
  "yarn.lock",
]);

/**
 * Row cap per report. Sized for "every changed file", not just documents;
 * with newest-first ordering this truncates the tail of a pathological run
 * rather than dropping recent work.
 */
export const GENERATED_FILE_LIMIT = 200;
/** Per-file inline snapshot cap; larger files are reported metadata-only. */
const GENERATED_FILE_CONTENT_MAX_BYTES = 2 * 1024 * 1024;
/** Total inline content budget per run.completed event. */
const GENERATED_FILE_CONTENT_TOTAL_MAX_BYTES = 8 * 1024 * 1024;
/** Walk bound so a pathological workspace cannot stall the daemon. */
const GENERATED_FILE_WALK_MAX_ENTRIES = 50_000;

const CONTENT_TYPES: Record<string, string> = {
  ".csv": "text/csv",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".gif": "image/gif",
  ".html": "text/html",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".json": "application/json",
  ".log": "text/plain",
  ".md": "text/markdown",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".svg": "image/svg+xml",
  ".tsv": "text/tab-separated-values",
  ".txt": "text/plain",
  ".webp": "image/webp",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

const SENSITIVE_FILE_NAME = /(?:^|[._-])(credential|credentials|secret|secrets|token|tokens|password|passwd|api[._-]?key|private[._-]?key)(?:[._-]|$)/i;
/** Private-key filenames: no bytes ever attach, but the filename itself
 * reaches the UI, so these are excluded outright. Mirrors
 * SENSITIVE_FILE_EXACT_NAMES / SENSITIVE_FILE_EXTENSIONS
 * (backend/relay/daemon_registry/artifacts.py). */
const SENSITIVE_FILE_EXACT_NAMES = new Set(["id_rsa", "id_dsa", "id_ecdsa", "id_ed25519"]);
const SENSITIVE_FILE_EXTENSIONS = new Set([".key", ".pem", ".p12", ".pfx", ".keystore", ".jks"]);
const LIKELY_SECRET_CONTENT = /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:OPENAI|ANTHROPIC|AWS|GITHUB|GOOGLE|RELAY)?_?(?:API_?KEY|ACCESS_?TOKEN|SECRET|PASSWORD)\s*["']?\s*[:=]\s*["']?[A-Za-z0-9_./+\-=]{8,}|\bsk-[A-Za-z0-9_-]{8,}|\bgh[pousr]_[A-Za-z0-9]{20,}|\bAKIA[A-Z0-9]{16})/i;

interface GeneratedFileCandidate {
  path: string;
  relativePath: string;
  title: string;
  bytes: number;
  mtimeMs: number;
  contentType: string;
  /** Whether this path's bytes may be stored. Candidacy is separate. */
  snapshotable: boolean;
}

type GeneratedFileSnapshot = Record<string, { mtimeMs: number; bytes: number }>;

interface GeneratedFileScanOptions {
  /** Shared project/task workspaces contain records belonging to other threads. */
  ownThreadId?: string;
  /**
   * The running agent's own personal-home subdir (slash-separated, e.g.
   * "agents/agent-<b64>"). When set, sibling agents/* homes are skipped so a
   * concurrent agent's private files are never attributed to this run.
   */
  ownAgentHomeSubdir?: string;
}

function fileExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot).toLowerCase() : "";
}

/**
 * Text documents count only near a workspace root: directly in the thread
 * workspace, directly in the running agent's own home, or under an `output/`
 * directory in either, under `artifacts/`, or the thread's handoff records.
 * Paths are workspace-relative here, so an agent that writes
 * `guide.md` beside its work is reported, while `somecheckout/README.md` — a
 * repo file the run merely touched — is not. Mirrored in
 * `is_snapshotable_path` (backend/relay/daemon_registry/artifacts.py);
 * change both together.
 */
function isTextDocumentFile(relativePath: string, extension: string): boolean {
  if (!OUTPUT_FILE_TEXT_EXTENSIONS.has(extension)) return false;
  const parts = relativePath.split("/");
  const scoped =
    parts.length >= 3 && parts[0] === "agents" && parts[1].startsWith("agent-")
      ? parts.slice(2)
      : parts;
  return scoped.length === 1 || scoped[0] === "output" || scoped[0] === "artifacts"
    || /^HANDOFF\.(md|json)$/.test(threadRecordPath(scoped)?.rest.join("/") ?? "");
}

/**
 * Splits `<records dir>/<threadId>/...` into the thread and what follows, for
 * any records directory: `.relay/threads/` now, `.threads/` (which at a node
 * root also holds thread workspaces) and `threads/` where older runs left them.
 */
const [RELAY_DIR, RECORDS_SUBDIR] = THREAD_RECORDS_DIR.split("/");

/** A real directory, never a symbolic link the walk would follow out of the workspace. */
async function isPlainDirectory(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isDirectory();
  } catch {
    return false;
  }
}

function threadRecordPath(parts: string[]): { thread: string; rest: string[] } | null {
  for (const dir of THREAD_RECORDS_DIRS) {
    const prefix = dir.split("/");
    if (parts.length > prefix.length && prefix.every((segment, index) => parts[index] === segment)) {
      return { thread: parts[prefix.length], rest: parts.slice(prefix.length + 1) };
    }
  }
  return null;
}

function isSiblingAgentHome(relativeDir: string, ownAgentHomeSubdir: string | undefined): boolean {
  if (!ownAgentHomeSubdir) return false;
  if (!/^agents\/[^/]+$/.test(relativeDir)) return false;
  return relativeDir !== ownAgentHomeSubdir;
}

/** A credential-named file earns no record: the name alone is a leak. */
function isExcludedByName(name: string): boolean {
  return (
    SENSITIVE_FILE_NAME.test(name)
    || name === ".env"
    || name.startsWith(".env.")
    || SENSITIVE_FILE_EXACT_NAMES.has(name)
    || SENSITIVE_FILE_EXTENSIONS.has(fileExtension(name))
  );
}

/**
 * Whether this path's bytes may travel with the record.
 *
 * Exactly the old candidacy rule: binary/document types anywhere, text
 * documents only near a workspace root. Widening this widens what Relay
 * stores and serves, so it stays as narrow as it was audited.
 */
function isSnapshotableFile(relativePath: string, extension: string): boolean {
  return GENERATED_FILE_EXTENSIONS.has(extension) || isTextDocumentFile(relativePath, extension);
}

/** Whether a storable file's body looks like it carries a credential. */
async function hasLikelySecretContent(path: string, extension: string, bytes: number): Promise<boolean> {
  const textLike = OUTPUT_FILE_TEXT_EXTENSIONS.has(extension)
    || extension === ".csv"
    || extension === ".html"
    || extension === ".svg"
    || extension === ".tsv";
  if (!textLike || bytes > GENERATED_FILE_CONTENT_MAX_BYTES) return false;
  try {
    return LIKELY_SECRET_CONTENT.test(await readFile(path, "utf8"));
  } catch {
    return true;
  }
}

async function listCandidates(
  workspacePath: string | undefined,
  options: GeneratedFileScanOptions = {},
): Promise<GeneratedFileCandidate[]> {
  if (!workspacePath) return [];
  const ownAgentHomeSubdir = options.ownAgentHomeSubdir?.split(sep).join("/");
  const files: GeneratedFileCandidate[] = [];
  let visited = 0;
  const pending: string[] = [workspacePath];
  try {
    if (!(await lstat(workspacePath)).isDirectory()) return [];
  } catch {
    return [];
  }
  while (pending.length > 0) {
    const dir = pending.pop() as string;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (visited >= GENERATED_FILE_WALK_MAX_ENTRIES) return files;
      visited += 1;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        const relativeDir = relative(workspacePath, path).split(sep).join("/");
        if (GENERATED_FILE_EXCLUDED_DIRS.has(entry.name)) {
          // `.relay/` holds Relay's control files; only its thread records are walked.
          const records = join(path, RECORDS_SUBDIR);
          if (relativeDir === RELAY_DIR && await isPlainDirectory(records)) pending.push(records);
          continue;
        }
        if (isSiblingAgentHome(relativeDir, ownAgentHomeSubdir)) continue;
        const record = threadRecordPath(relativeDir.split("/"));
        if (options.ownThreadId && record && record.rest.length === 0
          && record.thread !== options.ownThreadId) continue;
        pending.push(path);
        continue;
      }
      if (!entry.isFile() || entry.name.startsWith("~$")) continue;
      if (isExcludedByName(entry.name) || GENERATED_FILE_EXCLUDED_NAMES.has(entry.name)) continue;
      const extension = fileExtension(entry.name);
      let stat;
      try {
        stat = await lstat(path);
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
    }
  }
  return files;
}

export async function snapshotGeneratedFiles(
  workspacePath: string | undefined,
  options: GeneratedFileScanOptions = {},
): Promise<GeneratedFileSnapshot> {
  const snapshot: GeneratedFileSnapshot = {};
  for (const item of await listCandidates(workspacePath, options)) {
    snapshot[item.path] = { mtimeMs: item.mtimeMs, bytes: item.bytes };
  }
  return snapshot;
}

export async function diffGeneratedFiles(
  workspacePath: string | undefined,
  before: GeneratedFileSnapshot,
  options: GeneratedFileScanOptions = {},
): Promise<DaemonGeneratedFile[]> {
  const changed = (await listCandidates(workspacePath, options))
    .filter((item) => {
      const previous = before[item.path];
      return !previous || previous.mtimeMs !== item.mtimeMs || previous.bytes !== item.bytes;
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, GENERATED_FILE_LIMIT);

  let contentBudget = GENERATED_FILE_CONTENT_TOTAL_MAX_BYTES;
  const files: DaemonGeneratedFile[] = [];
  for (const item of changed) {
    const file: DaemonGeneratedFile = {
      relativePath: item.relativePath,
      title: item.title,
      bytes: item.bytes,
      contentType: item.contentType,
    };
    files.push(file);
    if (!item.snapshotable) {
      file.snapshotSkipped = "not-snapshotable-type";
      continue;
    }
    if (item.bytes > GENERATED_FILE_CONTENT_MAX_BYTES || item.bytes > contentBudget) {
      file.snapshotSkipped = "too-large";
      continue;
    }
    if (await hasLikelySecretContent(item.path, fileExtension(item.title), item.bytes)) {
      file.snapshotSkipped = "sensitive";
      continue;
    }
    try {
      const body = await readFile(item.path);
      file.contentBase64 = body.toString("base64");
      file.bytes = body.length;
      contentBudget -= body.length;
    } catch {
      // The file vanished between the walk and the read.
      file.snapshotSkipped = "unreadable";
    }
  }
  return files;
}
