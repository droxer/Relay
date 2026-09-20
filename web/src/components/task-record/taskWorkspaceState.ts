/** Distinguish workspace availability from its directory contents.
 *
 *  Extracted from the component so the decision is testable without mounting
 *  React: "the computer is offline" and "the task produced nothing" look the
 *  same to a careless reader and must not be conflated in the UI. */
export type TaskWorkspaceState = "loading" | "unavailable" | "empty" | "ready" | "failed" | "not-created" | "offline" | "unsupported" | "denied";

export function taskWorkspaceState(query: {
  isLoading: boolean;
  error: unknown;
  data: { exists: boolean; entries: unknown[] } | undefined;
  path?: string;
}): TaskWorkspaceState {
  if (query.isLoading) return "loading";
  if (query.error) {
    const { status, code } = query.error as { status?: number; code?: string };
    if (status === 403) return "denied";
    if (code === "workspace-not-created") return "not-created";
    if (code === "computer-offline") return "offline";
    if (code === "workspace-unsupported") return "unsupported";
    return status === 503 ? "unavailable" : "failed";
  }
  if (!query.data || !query.data.exists) return "not-created";
  if (query.data.entries.length === 0 && !query.path) return "empty";
  return "ready";
}
