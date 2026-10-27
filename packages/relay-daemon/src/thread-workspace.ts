import {
  accessSync, constants, lstatSync, mkdirSync, readdirSync, realpathSync, renameSync, rmdirSync, rmSync, statSync,
} from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";

import { GUEST_WORKSPACE, type DaemonNodeSandboxMode } from "relay-core";

import { isLinkedWorkspaceSubpath, ProjectLinkError, type ProjectLinkRegistry } from "./project-links.js";

export interface ThreadWorkspace {
  sessionId: string;
  /** Directory on the computer that owns the daemon. */
  hostPath: string;
  /** Directory passed to the agent CLI (host path locally, guest path in BoxLite). */
  executionPath: string;
}

/**
 * Every thread workspace sits in this directory of the configured root, so
 * none crowds the files people and agents work on.
 */
export const THREADS_DIR = ".threads";
/** Every backlog task and automation directory sits in this directory of the root. */
export const TASK_WORKSPACES_DIR = "tasks";
/**
 * Every workspace keeps its threads' records (`HANDOFF.md`, `HANDOFF.json`)
 * beside Relay's other control files in `.relay/`.
 */
export const THREAD_RECORDS_DIR = ".relay/threads";
/** Where thread records lived before `.relay/threads/`; a backend from then still names it. */
export const DOT_THREAD_RECORDS_DIR = ".threads";
/** Where thread records lived before `.threads/`; an older backend still names it. */
export const LEGACY_THREAD_RECORDS_DIR = "threads";
export type ThreadRecordsDir =
  | typeof THREAD_RECORDS_DIR | typeof DOT_THREAD_RECORDS_DIR | typeof LEGACY_THREAD_RECORDS_DIR;
/** Newest first. */
export const THREAD_RECORDS_DIRS: readonly ThreadRecordsDir[] = [
  THREAD_RECORDS_DIR, DOT_THREAD_RECORDS_DIR, LEGACY_THREAD_RECORDS_DIR,
];
const THREAD_RECORD_FILES = new Set(["HANDOFF.md", "HANDOFF.json"]);
const THREAD_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
/** What a run.start from a backend that names no `artifactsDir` expects. */
export const DEFAULT_ARTIFACTS_DIR = "artifacts";
const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

/**
 * Owns the mapping from a Relay thread identity to an isolated directory below
 * the workspace root configured for this computer. The backend and agents only
 * need the returned workspace; path validation and host/guest translation stay
 * local to the execution plane.
 */
export class ThreadWorkspaceManager {
  readonly rootPath: string;
  /** Whether `migrateTaskRecords` has run; it sweeps once per process. */
  taskRecordsMigrated = false;

  constructor(
    rootPath: string,
    private readonly sandboxMode: DaemonNodeSandboxMode,
    /** Existing directories linked as project workspaces; none means `links/` paths never resolve. */
    private readonly projectLinks?: ProjectLinkRegistry,
  ) {
    this.rootPath = resolve(rootPath);
    assertWorkspaceRoot(this.rootPath);
  }

  resolve(sessionId: string): ThreadWorkspace {
    validateThreadId(sessionId);
    const legacyPath = resolve(this.rootPath, sessionId);
    // A thread started before `.threads/` keeps its directory at the root.
    const hostPath = pathExists(legacyPath)
      ? legacyPath
      : resolve(this.rootPath, THREADS_DIR, sessionId);
    if (!hostPath.startsWith(this.rootPath + sep)) {
      throw new Error(`Invalid thread id ${JSON.stringify(sessionId)}.`);
    }

    if (hostPath !== legacyPath) rejectSymlinkComponents(this.rootPath, [THREADS_DIR]);
    rejectSymbolicLink(hostPath);
    const realRoot = realpathSync(this.rootPath);
    try {
      const realThread = realpathSync(hostPath);
      if (realThread !== realRoot && !realThread.startsWith(realRoot + sep)) {
        throw new Error(`Thread workspace escapes the configured root: ${sessionId}.`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    return {
      sessionId,
      hostPath,
      executionPath: this.sandboxMode === "boxlite" ? GUEST_WORKSPACE : hostPath,
    };
  }

  ensure(sessionId: string): ThreadWorkspace {
    const workspace = this.resolve(sessionId);
    mkdirSync(workspace.hostPath, { recursive: true });
    // Re-resolve after creation so an existing file, symbolic link, or path
    // replaced during creation is rejected before it reaches an agent run.
    return this.resolve(sessionId);
  }

  resolveSubpath(sessionId: string, workspaceSubpath: string): ThreadWorkspace {
    validateThreadId(sessionId);
    const segments = validateWorkspaceSubpath(workspaceSubpath);
    if (isLinkedWorkspaceSubpath(workspaceSubpath)) return this.resolveLinked(sessionId, workspaceSubpath);
    const hostPath = resolve(this.rootPath, ...segments);
    if (!hostPath.startsWith(this.rootPath + sep)) {
      throw new Error(`Invalid durable workspace path ${JSON.stringify(workspaceSubpath)}.`);
    }
    rejectSymlinkComponents(this.rootPath, segments);
    assertContainedRealPath(this.rootPath, hostPath, "Durable workspace");
    return {
      sessionId,
      hostPath,
      executionPath: this.sandboxMode === "boxlite" ? GUEST_WORKSPACE : hostPath,
    };
  }

  ensureSubpath(sessionId: string, workspaceSubpath: string): ThreadWorkspace {
    // A linked directory already exists by definition; never create one in its place.
    if (isLinkedWorkspaceSubpath(workspaceSubpath)) return this.resolveSubpath(sessionId, workspaceSubpath);
    const workspace = this.resolveSubpath(sessionId, workspaceSubpath);
    mkdirSync(workspace.hostPath, { recursive: true });
    return this.resolveSubpath(sessionId, workspaceSubpath);
  }

  /**
   * Record ownership follows the thread; deliverables follow the bound
   * workspace. `artifactsDir` is where this run's deliverables go, relative
   * to the workspace: `artifacts/` for a thread or task, `artifacts/<taskId>/`
   * for an automation occurrence sharing its automation's directory, and null
   * for a project, whose directory is the deliverable location itself.
   * `recordsDir` follows the handoff path the backend named.
   */
  ensureRecords(
    workspace: ThreadWorkspace,
    artifactsDir: string | null = DEFAULT_ARTIFACTS_DIR,
    recordsDir: ThreadRecordsDir = THREAD_RECORDS_DIR,
  ): void {
    validateThreadId(workspace.sessionId);
    // Records move only forward, into the directory the backend named.
    for (const older of THREAD_RECORDS_DIRS.slice(THREAD_RECORDS_DIRS.indexOf(recordsDir) + 1)) {
      moveOlderRecords(workspace.hostPath, workspace.sessionId, older, recordsDir);
    }
    const records = [[...recordsDir.split("/"), workspace.sessionId]];
    if (artifactsDir !== null) records.push(validateWorkspaceSubpath(artifactsDir));
    for (const segments of records) {
      rejectSymlinkComponents(workspace.hostPath, segments);
      const path = resolve(workspace.hostPath, ...segments);
      mkdirSync(path, { recursive: true });
      rejectSymlinkComponents(workspace.hostPath, segments);
      assertContainedRealPath(workspace.hostPath, path, "Thread records");
    }
  }

  /**
   * Moves every thread's older records in every task workspace into
   * `.relay/threads/`. A thread's records otherwise move only when that thread
   * runs again, and an automation run's thread never does, so each run it
   * finished before the move would keep its handoff in `.threads/` or
   * `threads/`. Call it only once a backend names `.relay/threads/`: an older
   * one still looks for records where it left them. Returns how many threads'
   * records moved; a workspace that cannot be swept is reported, not thrown.
   */
  migrateTaskRecords(onError: (workspace: string, error: Error) => void = () => {}): number {
    this.taskRecordsMigrated = true;
    const tasksRoot = resolve(this.rootPath, TASK_WORKSPACES_DIR);
    if (!isPlainDirectory(tasksRoot)) return 0;
    let moved = 0;
    for (const entry of readdirSync(tasksRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || !isValidThreadId(entry.name)) continue;
      const hostPath = resolve(tasksRoot, entry.name);
      try {
        assertContainedRealPath(this.rootPath, hostPath, "Task workspace");
        moved += migrateWorkspaceRecords(hostPath);
      } catch (error) {
        onError(`${TASK_WORKSPACES_DIR}/${entry.name}`, error as Error);
      }
    }
    return moved;
  }

  private resolveLinked(sessionId: string, workspaceSubpath: string): ThreadWorkspace {
    if (!this.projectLinks) {
      throw new ProjectLinkError("not-allowed", "This daemon does not support linked project directories.");
    }
    const hostPath = this.projectLinks.resolve(workspaceSubpath);
    return {
      sessionId,
      hostPath,
      executionPath: this.sandboxMode === "boxlite" ? GUEST_WORKSPACE : hostPath,
    };
  }

  /** Only the canonical root of one project may be permanently removed. */
  deleteProject(projectId: string, workspaceSubpath: string): void {
    validateThreadId(projectId);
    if (workspaceSubpath !== `projects/${projectId}`) {
      throw new Error("Project cleanup requires its canonical workspace path.");
    }
    const workspace = this.resolveSubpath(projectId, workspaceSubpath);
    rmSync(workspace.hostPath, { recursive: true, force: true });
  }

  /** Existing sessions created before thread directories keep their node-root cwd. */
  nodeRoot(sessionId: string): ThreadWorkspace {
    return {
      sessionId,
      hostPath: this.rootPath,
      executionPath: this.sandboxMode === "boxlite" ? GUEST_WORKSPACE : this.rootPath,
    };
  }
}

function isValidThreadId(sessionId: string): boolean {
  return THREAD_ID_PATTERN.test(sessionId)
    && sessionId !== "."
    && sessionId !== ".."
    && !sessionId.endsWith(".")
    && !WINDOWS_RESERVED_NAME.test(sessionId);
}

function validateThreadId(sessionId: string): void {
  if (!isValidThreadId(sessionId)) {
    throw new Error(`Invalid thread id ${JSON.stringify(sessionId)}.`);
  }
}

function validateWorkspaceSubpath(workspaceSubpath: string): string[] {
  if (
    typeof workspaceSubpath !== "string"
    || workspaceSubpath.length === 0
    || workspaceSubpath.includes("\\")
    || isAbsolute(workspaceSubpath)
  ) {
    throw new Error(`Invalid durable workspace path ${JSON.stringify(workspaceSubpath)}.`);
  }
  const segments = workspaceSubpath.split("/");
  if (
    segments.some((segment) =>
      !THREAD_ID_PATTERN.test(segment)
      || segment === "."
      || segment === ".."
      || segment.endsWith(".")
      || WINDOWS_RESERVED_NAME.test(segment)
    )
  ) {
    throw new Error(`Invalid durable workspace path ${JSON.stringify(workspaceSubpath)}.`);
  }
  return segments;
}

function assertWorkspaceRoot(rootPath: string): void {
  const info = statSync(rootPath);
  if (!info.isDirectory()) {
    throw new Error(`Configured workspace root is not a directory: ${rootPath}.`);
  }
  accessSync(rootPath, constants.R_OK | constants.W_OK);
}

/**
 * Moves this thread's records from `<older>/<id>/` into `<recordsDir>/<id>/`,
 * then drops `<older>/` once nothing is left in it. Only a directory holding
 * nothing but record files moves: a linked project may keep its own
 * `threads/` folder, and at a node root `.threads/<id>/` is a thread's whole
 * workspace. Runs inside the workspace's run gate, so no other run of it is
 * writing.
 */
/** Moves every thread's records out of the older records directories of one
 *  workspace; returns how many threads' records moved. Only a non-empty
 *  folder of records is a thread's, so an empty one is left where it is. */
function migrateWorkspaceRecords(hostPath: string): number {
  let moved = 0;
  for (const older of THREAD_RECORDS_DIRS.slice(1)) {
    const olderRoot = resolve(hostPath, older);
    if (!isPlainDirectory(olderRoot)) continue;
    for (const entry of readdirSync(olderRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || !isValidThreadId(entry.name)) continue;
      if (readdirSync(resolve(olderRoot, entry.name)).length === 0) continue;
      if (moveOlderRecords(hostPath, entry.name, older, THREAD_RECORDS_DIR)) moved += 1;
    }
  }
  return moved;
}

function moveOlderRecords(
  hostPath: string, sessionId: string, older: ThreadRecordsDir, recordsDir: ThreadRecordsDir,
): boolean {
  const olderRoot = resolve(hostPath, older);
  const source = resolve(olderRoot, sessionId);
  const targetSegments = recordsDir.split("/");
  const target = resolve(hostPath, ...targetSegments, sessionId);
  if (!isPlainDirectory(olderRoot) || !isPlainDirectory(source) || pathExists(target)) return false;
  const entries = readdirSync(source, { withFileTypes: true });
  if (!entries.every((entry) => entry.isFile() && THREAD_RECORD_FILES.has(entry.name))) return false;
  rejectSymlinkComponents(hostPath, targetSegments);
  mkdirSync(resolve(hostPath, ...targetSegments), { recursive: true });
  rejectSymlinkComponents(hostPath, targetSegments);
  assertContainedRealPath(hostPath, resolve(hostPath, ...targetSegments), "Thread records");
  renameSync(source, target);
  if (readdirSync(olderRoot).length === 0) rmdirSync(olderRoot);
  return true;
}

function isPlainDirectory(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function rejectSymbolicLink(path: string): void {
  try {
    if (lstatSync(path).isSymbolicLink()) {
      throw new Error(`Thread workspace must not be a symbolic link: ${path}.`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function rejectSymlinkComponents(rootPath: string, segments: string[]): void {
  let current = rootPath;
  for (const segment of segments) {
    current = resolve(current, segment);
    try {
      if (lstatSync(current).isSymbolicLink()) {
        throw new Error(`Durable workspace must not contain a symbolic link: ${current}.`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}

function assertContainedRealPath(rootPath: string, targetPath: string, label: string): void {
  const realRoot = realpathSync(rootPath);
  try {
    const realTarget = realpathSync(targetPath);
    if (realTarget !== realRoot && !realTarget.startsWith(realRoot + sep)) {
      throw new Error(`${label} escapes the configured root.`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
