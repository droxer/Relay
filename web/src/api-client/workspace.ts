import type {
  ArtifactsResponse,
  ProjectWorkspaceFileResponse,
  ProjectWorkspaceFilesResponse,
  TaskWorkspaceFileResponse,
  TaskWorkspaceFilesResponse,
  WorkspaceActivityResponse,
  WorkspaceActivityThreads,
  WorkspaceBriefResponse,
  WorkspaceFileEntry,
} from "../types.ts";
import { apiJson, privateConditionalJson, type PrivateResponseCache } from "./client.ts";
import { DEFAULT_WORKSPACE_FILE_ROOTS, OLDER_THREAD_RECORDS_ROOTS } from "../lib/workspaceFileTabs.ts";

const THREAD_RECORDS_ROOT = DEFAULT_WORKSPACE_FILE_ROOTS.activities;

export function listArtifacts(
  input: { userId?: string; workspacePath?: string } = {},
  signal?: AbortSignal,
): Promise<ArtifactsResponse> {
  const params = new URLSearchParams();
  if (input.userId) params.set("userId", input.userId);
  if (input.workspacePath) params.set("workspacePath", input.workspacePath);
  const query = params.toString();
  return apiJson<ArtifactsResponse>(`/artifacts${query ? `?${query}` : ""}`, { signal });
}

type WorkspaceScope = { userId?: string; agentId?: string; teamId?: string; projectId?: string };

function workspaceBriefPath(input: WorkspaceScope, view?: "activity"): string {
  const params = new URLSearchParams();
  if (input.userId) params.set("userId", input.userId);
  if (input.agentId) params.set("agentId", input.agentId);
  if (input.teamId) params.set("teamId", input.teamId);
  if (input.projectId) params.set("projectId", input.projectId);
  if (view) params.set("view", view);
  const query = params.toString();
  return `/workspace/brief${query ? `?${query}` : ""}`;
}

export function getWorkspaceBrief(input: WorkspaceScope = {}, signal?: AbortSignal): Promise<WorkspaceBriefResponse> {
  return apiJson(workspaceBriefPath(input), { signal });
}

export function getWorkspaceActivity(
  input: WorkspaceScope, signal?: AbortSignal, cache?: PrivateResponseCache<WorkspaceActivityResponse>,
): Promise<WorkspaceActivityResponse> {
  return privateConditionalJson(`${workspaceBriefPath(input, "activity")}&threadLimit=20`, signal, cache);
}

export function getOlderWorkspaceThreads(input: WorkspaceScope, cursor: string, signal?: AbortSignal): Promise<WorkspaceActivityThreads> {
  return apiJson(`${workspaceBriefPath(input, "activity")}&threadLimit=20&threadCursor=${encodeURIComponent(cursor)}`, { signal });
}

export function listProjectWorkspaceFiles(
  input: { projectId: string; path?: string },
  signal?: AbortSignal,
): Promise<ProjectWorkspaceFilesResponse> {
  return listWorkspaceFiles<ProjectWorkspaceFilesResponse>(
    `/projects/${encodeURIComponent(input.projectId)}/workspace/files`, input.path, signal,
  );
}

export function readProjectWorkspaceFile(
  input: { projectId: string; path: string },
  signal?: AbortSignal,
): Promise<ProjectWorkspaceFileResponse> {
  const params = new URLSearchParams({ path: input.path });
  return apiJson<ProjectWorkspaceFileResponse>(`/projects/${encodeURIComponent(input.projectId)}/workspace/file?${params.toString()}`, { signal });
}

export function listTaskWorkspaceFiles(
  input: { taskId: string; path?: string },
  signal?: AbortSignal,
): Promise<TaskWorkspaceFilesResponse> {
  return listWorkspaceFiles<TaskWorkspaceFilesResponse>(
    `/tasks/${encodeURIComponent(input.taskId)}/workspace/files`, input.path, signal,
  );
}

/** Activity spans every records layout until each historical thread has run again.
 * Keep actual entry paths so previews and directory navigation use real files.
 * Current records win duplicate names; errors still surface to the browser. */
async function listWorkspaceFiles<T extends { path: string; exists: boolean; entries: WorkspaceFileEntry[] }>(
  endpoint: string, path = "", signal?: AbortSignal,
): Promise<T> {
  const list = (folder: string, view?: "activity") => {
    const params = new URLSearchParams(folder ? { path: folder } : {});
    if (view) params.set("view", view);
    const query = params.toString();
    return apiJson<T & { threadRecordsMerged?: true }>(`${endpoint}${query ? `?${query}` : ""}`, { signal });
  };
  if (path !== THREAD_RECORDS_ROOT && !path.startsWith(`${THREAD_RECORDS_ROOT}/`)) return list(path);
  const current = await list(path, "activity");
  if (current.threadRecordsMerged) return { ...current, entries: [...current.entries].sort(compareActivityEntries) };

  // Older backends answer only for the requested path.
  const rest = path.slice(THREAD_RECORDS_ROOT.length);
  const older = await Promise.all(OLDER_THREAD_RECORDS_ROOTS.map(root => list(`${root}${rest}`)));
  const entries = new Map<string, WorkspaceFileEntry>();
  for (const listing of [...older.reverse(), current]) {
    for (const entry of listing.entries) entries.set(entry.name, entry);
  }
  return {
    ...current,
    exists: [current, ...older].some(listing => listing.exists),
    entries: [...entries.values()].sort(compareActivityEntries),
  };
}

function compareActivityEntries(left: WorkspaceFileEntry, right: WorkspaceFileEntry): number {
  return left.kind === right.kind
    ? left.name.toLowerCase().localeCompare(right.name.toLowerCase())
    : left.kind === "directory" ? -1 : 1;
}

export function readTaskWorkspaceFile(
  input: { taskId: string; path: string },
  signal?: AbortSignal,
): Promise<TaskWorkspaceFileResponse> {
  const params = new URLSearchParams({ path: input.path });
  return apiJson<TaskWorkspaceFileResponse>(`/tasks/${encodeURIComponent(input.taskId)}/workspace/file?${params.toString()}`, { signal });
}
