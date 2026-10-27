import { existsSync, lstatSync, renameSync, symlinkSync } from "node:fs";
import { dirname, relative } from "node:path";
import type { SupervisorLogger } from "./types.js";

/** Managed computers' workspaces, one child directory per node. */
export const WORKSPACE_ROOT = ".relay-workspaces";

// Earlier defaults, newest first: before the move out of `.relay/`, and
// before the employee → user rename.
const LEGACY_WORKSPACE_ROOTS = [".relay/user-workspaces", ".relay/employee-workspaces"];

export interface WorkspaceRootFs {
  exists(path: string): boolean;
  isSymlink(path: string): boolean;
  rename(from: string, to: string): void;
  symlink(target: string, path: string): void;
}

const nodeFs: WorkspaceRootFs = {
  exists: existsSync,
  isSymlink: (path) => {
    try {
      return lstatSync(path).isSymbolicLink();
    } catch {
      return false;
    }
  },
  rename: renameSync,
  symlink: (target, path) => symlinkSync(target, path, "dir"),
};

/**
 * The default workspace root, moving a deployment's older root to it once.
 *
 * Managed daemons run detached and outlive a supervisor restart, so the old
 * path is left as a symlink to the new root: a daemon still running there
 * keeps resolving its workspace, and picks up the new path when it restarts.
 * If the move cannot complete, the older root stays in use.
 */
export function defaultWorkspaceRoot(fs: WorkspaceRootFs = nodeFs, logger?: SupervisorLogger): string {
  if (fs.exists(WORKSPACE_ROOT)) return WORKSPACE_ROOT;
  const legacy = LEGACY_WORKSPACE_ROOTS.find((path) => fs.exists(path) && !fs.isSymlink(path));
  if (!legacy) return WORKSPACE_ROOT;
  try {
    fs.rename(legacy, WORKSPACE_ROOT);
  } catch (error) {
    logger?.warn("workspace root move failed; keeping the older root", { from: legacy, to: WORKSPACE_ROOT, error: errorMessage(error) });
    return legacy;
  }
  try {
    fs.symlink(relative(dirname(legacy), WORKSPACE_ROOT), legacy);
  } catch (error) {
    fs.rename(WORKSPACE_ROOT, legacy);
    logger?.warn("workspace root link failed; keeping the older root", { from: legacy, to: WORKSPACE_ROOT, error: errorMessage(error) });
    return legacy;
  }
  logger?.info("workspace root moved", { from: legacy, to: WORKSPACE_ROOT });
  return WORKSPACE_ROOT;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
