/** The two areas the workspace file browser splits into. */
export type WorkspaceFileTab = "artifacts" | "activities";

/** Where each tab's root sits, relative to the workspace being browsed. */
export interface WorkspaceFileRoots {
  /** The deliverables folder: `artifacts` for a thread or task,
   *  `artifacts/<taskId>` for one automation run, and "" for a project,
   *  whose directory is the deliverable location itself. */
  artifacts: string;
  /** Per-thread records (`.threads/<threadId>/HANDOFF.md`). */
  activities: string;
}

const THREAD_RECORDS_ROOT = ".threads";
const DEFAULT_ARTIFACTS_ROOT = "artifacts";

/** A thread or backlog task: deliverables under `artifacts/`. */
export const DEFAULT_WORKSPACE_FILE_ROOTS: WorkspaceFileRoots = {
  artifacts: DEFAULT_ARTIFACTS_ROOT,
  activities: THREAD_RECORDS_ROOT,
};

/** A project: the workspace itself holds the deliverables. */
export const PROJECT_WORKSPACE_FILE_ROOTS: WorkspaceFileRoots = {
  artifacts: "",
  activities: THREAD_RECORDS_ROOT,
};

/** The roots for a workspace whose deliverables folder the API named:
 *  a string is that folder, null means the workspace itself (a project),
 *  and undefined (an older response) keeps `artifacts/`. */
export function workspaceFileRoots(artifactsDir: string | null | undefined): WorkspaceFileRoots {
  if (artifactsDir === null) return PROJECT_WORKSPACE_FILE_ROOTS;
  if (artifactsDir === undefined || artifactsDir === DEFAULT_ARTIFACTS_ROOT) return DEFAULT_WORKSPACE_FILE_ROOTS;
  return { artifacts: artifactsDir, activities: THREAD_RECORDS_ROOT };
}

/** Where a thread's or task's file browser opens: its Artifacts tab. */
export const DEFAULT_WORKSPACE_BROWSE_PATH = DEFAULT_WORKSPACE_FILE_ROOTS.artifacts;

function under(path: string, root: string): boolean {
  if (root === "") return true;
  return path === root || path.startsWith(`${root}/`);
}

/** Which tab a browse path belongs to, or null when the path sits outside
 *  both roots (the workspace home itself, or a run-rooted browse). Thread
 *  records are checked first, since a project's Files root is everything. */
export function workspaceFileTabForPath(
  path: string,
  roots: WorkspaceFileRoots = DEFAULT_WORKSPACE_FILE_ROOTS,
): WorkspaceFileTab | null {
  if (under(path, roots.activities) || under(path, "threads")) return "activities";
  if (under(path, roots.artifacts)) return "artifacts";
  return null;
}

/** The tab whose root `path` is exactly, or null for any other folder. */
export function workspaceTabRootFor(
  path: string,
  roots: WorkspaceFileRoots = DEFAULT_WORKSPACE_FILE_ROOTS,
): WorkspaceFileTab | null {
  const tab = workspaceFileTabForPath(path, roots);
  return tab && (roots[tab] === path || (tab === "activities" && path === "threads")) ? tab : null;
}

/* The workspace root is the empty path, and URL canonicalization drops an
   empty param — which would read back as the default tab. The root rides the
   URL as "/" instead, a value no workspace-relative path can take. */
const ROOT_PARAM = "/";

/** Reads a `?path=` value: absent is `defaultPath`, "/" the workspace root. */
export function parseWorkspaceBrowsePath(
  value: string | null,
  defaultPath: string = DEFAULT_WORKSPACE_BROWSE_PATH,
): string {
  if (value === null || value === "") return defaultPath;
  return value === ROOT_PARAM ? "" : value;
}

/** Writes a browse path as a `?path=` value; null keeps the default out of
 *  the URL. */
export function serializeWorkspaceBrowsePath(
  path: string,
  defaultPath: string = DEFAULT_WORKSPACE_BROWSE_PATH,
): string | null {
  if (path === defaultPath) return null;
  return path === "" ? ROOT_PARAM : path;
}

/* Relay's own bookkeeping inside a project directory: thread records (the
   Activity tab, and `threads/` where older runs left them), agents' private
   homes, and the daemon's control files. */
const PROJECT_INTERNAL_ENTRIES = new Set([THREAD_RECORDS_ROOT, "threads", "agents", ".relay"]);

/** Whether a listing entry at `path` is Relay's own, not the user's files.
 *  Only the project root hides anything: a thread or task browser never
 *  lists its workspace root by default, and deeper folders are the user's. */
export function isWorkspaceInternalEntry(name: string, path: string, roots: WorkspaceFileRoots): boolean {
  return roots.artifacts === "" && path === "" && PROJECT_INTERNAL_ENTRIES.has(name);
}
