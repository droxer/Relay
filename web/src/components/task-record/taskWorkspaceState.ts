import { WORKSPACE_FILE_TAB_ROOT } from "../../lib/workspaceFileTabs.js";

/** Distinguish workspace availability from its directory contents.
 *
 *  Extracted from the component so the decision is testable without mounting
 *  React: "the computer is offline" and "the task produced nothing" look the
 *  same to a careless reader and must not be conflated in the UI. */
type TaskWorkspaceState = "loading" | "unavailable" | "empty" | "ready" | "failed" | "not-created" | "offline" | "unsupported" | "denied";

/** The workspace-relative directories the file browser's tabs root at. A
 *  missing or empty tab root is an empty area of an existing workspace, not a
 *  missing workspace — the other tab may still hold records. */
const TAB_ROOTS: Record<string, true> = Object.fromEntries(
  Object.values(WORKSPACE_FILE_TAB_ROOT).map((root) => [root, true]),
);

export function taskWorkspaceState(query: {
  isLoading: boolean;
  error: unknown;
  data: { exists: boolean; entries: unknown[] } | undefined;
  path?: string;
}): TaskWorkspaceState {
  const path = query.path ?? "";
  const atTabRoot = TAB_ROOTS[path] === true;
  // Below the root (a folder deeper than a tab root) the explorer is already
  // on screen, and every one of these states replaces it with a notice —
  // taking the path bar with it. A folder that vanished (or failed to read)
  // then trapped the reader: refresh re-requested the same path and nothing
  // navigated up, and each folder change flashed the whole explorer out for a
  // loading line. Inside a folder the listing reports loading, errors, and
  // missing directories itself.
  if (path && !atTabRoot) return "ready";
  if (query.isLoading) return "loading";
  if (query.error) {
    const { status, code } = query.error as { status?: number; code?: string };
    if (status === 403) return "denied";
    if (code === "workspace-not-created") return "not-created";
    if (code === "computer-offline") return "offline";
    if (code === "workspace-unsupported") return "unsupported";
    return status === 503 ? "unavailable" : "failed";
  }
  if (!query.data || !query.data.exists) return atTabRoot ? "ready" : "not-created";
  if (query.data.entries.length === 0) return atTabRoot ? "ready" : "empty";
  return "ready";
}
