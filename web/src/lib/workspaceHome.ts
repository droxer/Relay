import type { ProjectWorkspaceFilesResponse } from "../types.js";

/** What the Files pane header shows about the workspace's data source. */
type WorkspaceHomeStatus =
  | { kind: "live"; nodeId: string | null }
  | { kind: "none" };

export function workspaceHomeStatus(
  files: Pick<ProjectWorkspaceFilesResponse, "source" | "nodeId"> | undefined,
): WorkspaceHomeStatus {
  if (files?.source === "live") return { kind: "live", nodeId: files.nodeId ?? null };
  return { kind: "none" };
}

/** Only a placement-unavailable (503) listing failure gets a retry button. */
export function isWorkspaceRetryableError(error: unknown): boolean {
  // Structural check avoids a value import of RelayApiError (Next webpack
  // cannot resolve the NodeNext `.js` specifier that packages/tsconfig needs).
  return error instanceof Error
    && "status" in error
    && (error as Error & { status: unknown }).status === 503;
}
