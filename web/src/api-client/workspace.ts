import type {
  ArtifactsResponse,
  ProjectWorkspaceFileResponse,
  ProjectWorkspaceFilesResponse,
  TaskWorkspaceFileResponse,
  TaskWorkspaceFilesResponse,
  WorkspaceBriefResponse,
  WorkspaceFileEntry,
} from "../types.ts";
import { apiJson } from "./client.ts";
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

export function getWorkspaceBrief(
  input: { userId?: string; agentId?: string; teamId?: string; projectId?: string } = {},
  signal?: AbortSignal,
): Promise<WorkspaceBriefResponse> {
  const params = new URLSearchParams();
  if (input.userId) params.set("userId", input.userId);
  if (input.agentId) params.set("agentId", input.agentId);
  if (input.teamId) params.set("teamId", input.teamId);
  if (input.projectId) params.set("projectId", input.projectId);
  const query = params.toString();
  return apiJson<WorkspaceBriefResponse>(`/workspace/brief${query ? `?${query}` : ""}`, { signal });
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
  const list = (folder: string): Promise<T> => {
    const query = new URLSearchParams(folder ? { path: folder } : {}).toString();
    return apiJson<T>(`${endpoint}${query ? `?${query}` : ""}`, { signal });
  };
  if (path !== THREAD_RECORDS_ROOT && !path.startsWith(`${THREAD_RECORDS_ROOT}/`)) return list(path);
  const rest = path.slice(THREAD_RECORDS_ROOT.length);
  // Oldest first, so newer records win a name both hold.
  const [current, ...older] = await Promise.all(
    [path, ...OLDER_THREAD_RECORDS_ROOTS.map(root => `${root}${rest}`)].map(list),
  );
  const entries = new Map<string, WorkspaceFileEntry>();
  for (const listing of [...older].reverse().concat(current)) {
    for (const entry of listing.entries) entries.set(entry.name, entry);
  }
  return {
    ...current,
    exists: [current, ...older].some(listing => listing.exists),
    entries: [...entries.values()].sort((left, right) => left.kind === right.kind
      ? left.name.toLowerCase().localeCompare(right.name.toLowerCase())
      : left.kind === "directory" ? -1 : 1),
  };
}

export function readTaskWorkspaceFile(
  input: { taskId: string; path: string },
  signal?: AbortSignal,
): Promise<TaskWorkspaceFileResponse> {
  const params = new URLSearchParams({ path: input.path });
  return apiJson<TaskWorkspaceFileResponse>(`/tasks/${encodeURIComponent(input.taskId)}/workspace/file?${params.toString()}`, { signal });
}
