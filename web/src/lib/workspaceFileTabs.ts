/** The two areas the workspace file browser splits into. */
export type WorkspaceFileTab = "artifacts" | "activities";

const WORKSPACE_FILE_TABS = ["artifacts", "activities"] as const;

/** The workspace-relative directory each tab lists at its root. */
export const WORKSPACE_FILE_TAB_ROOT: Record<WorkspaceFileTab, string> = {
  artifacts: "artifacts",
  activities: "threads",
};

/** Where a file browser opens: the Artifacts tab. */
export const DEFAULT_WORKSPACE_BROWSE_PATH = WORKSPACE_FILE_TAB_ROOT.artifacts;

/** Which tab a browse path belongs to, or null when the path sits outside
 *  both roots (the workspace home itself, or a run-rooted browse). */
export function workspaceFileTabForPath(path: string): WorkspaceFileTab | null {
  for (const tab of WORKSPACE_FILE_TABS) {
    const root = WORKSPACE_FILE_TAB_ROOT[tab];
    if (path === root || path.startsWith(`${root}/`)) return tab;
  }
  return null;
}

/** The tab whose root `path` is exactly, or null for any other folder. */
export function workspaceTabRootFor(path: string): WorkspaceFileTab | null {
  const tab = workspaceFileTabForPath(path);
  return tab && WORKSPACE_FILE_TAB_ROOT[tab] === path ? tab : null;
}

/* The workspace root is the empty path, and URL canonicalization drops an
   empty param — which would read back as the default tab. The root rides the
   URL as "/" instead, a value no workspace-relative path can take. */
const ROOT_PARAM = "/";

/** Reads a `?path=` value: absent is the default tab, "/" the workspace root. */
export function parseWorkspaceBrowsePath(value: string | null): string {
  if (value === null || value === "") return DEFAULT_WORKSPACE_BROWSE_PATH;
  return value === ROOT_PARAM ? "" : value;
}

/** Writes a browse path as a `?path=` value; null keeps the default out of
 *  the URL. */
export function serializeWorkspaceBrowsePath(path: string): string | null {
  if (path === DEFAULT_WORKSPACE_BROWSE_PATH) return null;
  return path === "" ? ROOT_PARAM : path;
}
