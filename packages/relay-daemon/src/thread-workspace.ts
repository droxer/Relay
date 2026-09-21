import { accessSync, constants, lstatSync, mkdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";

import { GUEST_WORKSPACE, type DaemonNodeSandboxMode } from "relay-core";

export interface ThreadWorkspace {
  sessionId: string;
  /** Directory on the computer that owns the daemon. */
  hostPath: string;
  /** Directory passed to the agent CLI (host path locally, guest path in BoxLite). */
  executionPath: string;
}

const THREAD_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

/**
 * Owns the mapping from a Relay thread identity to an isolated directory below
 * the workspace root configured for this computer. The backend and agents only
 * need the returned workspace; path validation and host/guest translation stay
 * local to the execution plane.
 */
export class ThreadWorkspaceManager {
  readonly rootPath: string;

  constructor(
    rootPath: string,
    private readonly sandboxMode: DaemonNodeSandboxMode,
  ) {
    this.rootPath = resolve(rootPath);
    assertWorkspaceRoot(this.rootPath);
  }

  resolve(sessionId: string): ThreadWorkspace {
    validateThreadId(sessionId);
    const hostPath = resolve(this.rootPath, sessionId);
    if (!hostPath.startsWith(this.rootPath + sep)) {
      throw new Error(`Invalid thread id ${JSON.stringify(sessionId)}.`);
    }

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
    const workspace = this.resolveSubpath(sessionId, workspaceSubpath);
    mkdirSync(workspace.hostPath, { recursive: true });
    return this.resolveSubpath(sessionId, workspaceSubpath);
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

function validateThreadId(sessionId: string): void {
  if (
    !THREAD_ID_PATTERN.test(sessionId)
    || sessionId === "."
    || sessionId === ".."
    || sessionId.endsWith(".")
    || WINDOWS_RESERVED_NAME.test(sessionId)
  ) {
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
