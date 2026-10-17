/** The two areas the workspace file browser splits into. */
export type WorkspaceFileTab = "artifacts" | "activities";

/** The workspace-relative directory each tab lists at its root. */
export const WORKSPACE_FILE_TAB_ROOT: Record<WorkspaceFileTab, string> = {
  artifacts: "artifacts",
  activities: "threads",
};

/** Which tab a browse path belongs to, or null when the path sits outside
 *  both roots (the workspace home itself, or a run-rooted browse). */
export function workspaceFileTabForPath(path: string): WorkspaceFileTab | null {
  for (const tab of ["artifacts", "activities"] as const) {
    const root = WORKSPACE_FILE_TAB_ROOT[tab];
    if (path === root || path.startsWith(`${root}/`)) return tab;
  }
  return null;
}
