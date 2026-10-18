import { workspaceTabRootFor } from "../../lib/workspaceFileTabs.ts";

/** Distinguish workspace availability from its directory contents.
 *
 *  Extracted from the component so the decision is testable without mounting
 *  React: "the computer is offline" and "the task produced nothing" look the
 *  same to a careless reader and must not be conflated in the UI. */
type TaskWorkspaceState = "loading" | "unavailable" | "empty" | "ready" | "failed" | "not-created" | "offline" | "unsupported" | "denied";

type RootCheck = { isLoading: boolean; error: unknown; data: { exists: boolean } | undefined };

export function taskWorkspaceState(query: {
  isLoading: boolean;
  error: unknown;
  data: { exists: boolean; entries: unknown[] } | undefined;
  path?: string;
  /** The workspace root's listing, fetched only when a tab root is missing:
   *  the daemon answers "no such folder" alike for a missing `artifacts/` and
   *  a workspace that was never created, and only the root tells them apart. */
  root?: RootCheck;
}): TaskWorkspaceState {
  const path = query.path ?? "";
  const atTabRoot = workspaceTabRootFor(path) !== null;
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
  if (!query.data || !query.data.exists) return atTabRoot ? missingTabRootState(query.root) : "not-created";
  if (query.data.entries.length === 0) return atTabRoot ? "ready" : "empty";
  return "ready";
}

/** A tab root that does not exist is an empty area of a live workspace —
 *  unless the workspace itself is missing. A failed root check keeps the
 *  tabs on screen rather than guessing the workspace is gone. */
function missingTabRootState(root: RootCheck | undefined): TaskWorkspaceState {
  if (root?.error) return "ready";
  if (!root || root.isLoading || !root.data) return "loading";
  return root.data.exists ? "ready" : "not-created";
}
