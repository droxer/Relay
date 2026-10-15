import type {
  ArtifactsResponse,
  ProjectWorkspaceFileResponse,
  ProjectWorkspaceFilesResponse,
  TaskWorkspaceFileResponse,
  TaskWorkspaceFilesResponse,
  WorkspaceBriefResponse,
} from "../types.ts";
import { apiJson } from "./client.ts";

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
  const params = new URLSearchParams();
  if (input.path) params.set("path", input.path);
  const query = params.toString();
  return apiJson<ProjectWorkspaceFilesResponse>(`/projects/${encodeURIComponent(input.projectId)}/workspace/files${query ? `?${query}` : ""}`, { signal });
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
  const params = new URLSearchParams();
  if (input.path) params.set("path", input.path);
  const query = params.toString();
  return apiJson<TaskWorkspaceFilesResponse>(`/tasks/${encodeURIComponent(input.taskId)}/workspace/files${query ? `?${query}` : ""}`, { signal });
}

export function readTaskWorkspaceFile(
  input: { taskId: string; path: string },
  signal?: AbortSignal,
): Promise<TaskWorkspaceFileResponse> {
  const params = new URLSearchParams({ path: input.path });
  return apiJson<TaskWorkspaceFileResponse>(`/tasks/${encodeURIComponent(input.taskId)}/workspace/file?${params.toString()}`, { signal });
}
