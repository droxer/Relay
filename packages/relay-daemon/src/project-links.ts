import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, parse, relative, resolve } from "node:path";

import type { DaemonNodeSandboxMode, DaemonProjectLink, DaemonProjectLinkErrorCode } from "relay-core";

/** Durable subpaths in this namespace name a linked directory, never a child of the root. */
export const LINKED_WORKSPACE_PREFIX = "links/";

export class ProjectLinkError extends Error {
  constructor(readonly code: DaemonProjectLinkErrorCode, message: string) {
    super(message);
  }
}

export function isLinkedWorkspaceSubpath(workspaceSubpath: string): boolean {
  return workspaceSubpath.startsWith(LINKED_WORKSPACE_PREFIX);
}

/**
 * Roots a project may link an existing directory beneath. The daemon, not the
 * backend, decides: `RELAY_DAEMON_PROJECT_ROOTS` (path-delimited absolute
 * directories) wins; otherwise a direct-run computer allows the user's home and
 * a BoxLite computer allows nothing, so its guests only ever mount Relay's root.
 */
export function configuredProjectRoots(
  sandboxMode: DaemonNodeSandboxMode,
  raw: string | undefined = process.env.RELAY_DAEMON_PROJECT_ROOTS,
): string[] {
  const entries = raw === undefined
    ? sandboxMode === "none" ? [homedir()] : []
    : raw.split(delimiter).map((entry) => entry.trim()).filter(Boolean);
  const roots: string[] = [];
  for (const entry of entries) {
    if (!isAbsolute(entry)) continue;
    try {
      const real = canonical(entry);
      if (statSync(real).isDirectory() && !roots.includes(real)) roots.push(real);
    } catch {
      // A missing root allows nothing; it must not fail daemon startup.
    }
  }
  return roots;
}

/** macOS and Windows volumes ignore case by default, so containment must too. */
const CASE_INSENSITIVE_PATHS = process.platform === "darwin" || process.platform === "win32";

/** The native realpath also canonicalizes letter case, so `~/.RELAY` names `~/.relay`. */
function canonical(path: string): string {
  return realpathSync.native(path);
}

function within(parent: string, child: string): boolean {
  const [from, to] = CASE_INSENSITIVE_PATHS
    ? [parent.toLowerCase(), child.toLowerCase()]
    : [parent, child];
  const rest = relative(from, to);
  return rest === "" || (!rest.startsWith("..") && !isAbsolute(rest));
}

function overlaps(left: string, right: string): boolean {
  return within(left, right) || within(right, left);
}

function canonicalOrResolved(path: string): string {
  try {
    return canonical(path);
  } catch {
    return resolve(path);
  }
}

/**
 * The daemon-owned map from `links/<id>` workspace subpaths to existing
 * directories on this computer. Every lookup re-validates the directory, so a
 * link that later leaves the allowed roots, or is replaced by a symbolic link
 * elsewhere, fails its run rather than reaching an agent.
 */
export class ProjectLinkRegistry {
  private readonly links = new Map<string, string>();
  /** Why the last registration refused a link, so its runs can say so. */
  private readonly refusals = new Map<string, string>();
  private readonly protectedTrees: string[];

  constructor(
    readonly allowedRoots: string[],
    /**
     * Relay's workspace root (its threads, tasks, projects, and agent homes)
     * and the daemon's private credentials. A link may neither sit inside nor
     * contain any of them.
     */
    protectedTrees: string[],
  ) {
    this.protectedTrees = protectedTrees.map(canonicalOrResolved);
  }

  validate(hostPath: string): string {
    if (typeof hostPath !== "string" || !isAbsolute(hostPath)) {
      throw new ProjectLinkError("invalid-path", "The project directory must be an absolute path.");
    }
    let real: string;
    try {
      real = canonical(hostPath);
    } catch {
      throw new ProjectLinkError("not-found", `No directory exists at ${hostPath}.`);
    }
    if (!statSync(real).isDirectory()) {
      throw new ProjectLinkError("not-directory", `${hostPath} is not a directory.`);
    }
    if (real === parse(real).root) {
      throw new ProjectLinkError("protected", "A filesystem root cannot be a project directory.");
    }
    if (!this.allowedRoots.some((root) => within(root, real))) {
      throw new ProjectLinkError(
        "not-allowed",
        this.allowedRoots.length === 0
          ? "This computer does not allow linking existing directories. Set RELAY_DAEMON_PROJECT_ROOTS on it to enable this."
          : `${hostPath} is outside the directories this computer allows: ${this.allowedRoots.join(", ")}.`,
      );
    }
    if (this.protectedTrees.some((path) => overlaps(path, real))) {
      throw new ProjectLinkError(
        "protected",
        `${hostPath} overlaps Relay's own workspace or credential directories.`,
      );
    }
    try {
      accessSync(real, constants.R_OK | constants.W_OK);
    } catch {
      throw new ProjectLinkError("not-writable", `${hostPath} is not readable and writable by the daemon user.`);
    }
    return real;
  }

  link(workspaceSubpath: string, hostPath: string): string {
    if (!isLinkedWorkspaceSubpath(workspaceSubpath)) {
      throw new ProjectLinkError("invalid-path", `Invalid linked workspace path ${JSON.stringify(workspaceSubpath)}.`);
    }
    const real = this.validate(hostPath);
    this.links.set(workspaceSubpath, real);
    this.refusals.delete(workspaceSubpath);
    return real;
  }

  /** Replace the map with the backend's view; invalid entries stay unlinked and their runs fail. */
  replaceAll(links: readonly DaemonProjectLink[]): Array<{ workspaceSubpath: string; error: string }> {
    this.links.clear();
    this.refusals.clear();
    const rejected: Array<{ workspaceSubpath: string; error: string }> = [];
    for (const entry of links) {
      try {
        this.link(entry.workspaceSubpath, entry.hostPath);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.refusals.set(entry.workspaceSubpath, message);
        rejected.push({ workspaceSubpath: entry.workspaceSubpath, error: message });
      }
    }
    return rejected;
  }

  resolve(workspaceSubpath: string): string {
    const hostPath = this.links.get(workspaceSubpath);
    if (!hostPath) {
      const refusal = this.refusals.get(workspaceSubpath);
      throw new ProjectLinkError(
        "not-found",
        refusal
          ? `This computer no longer accepts the project's directory: ${refusal}`
          : "This project's directory is not linked on this computer. Reconnect the computer, then retry.",
      );
    }
    return this.validate(hostPath);
  }
}
