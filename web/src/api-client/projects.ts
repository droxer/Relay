import type {
  CreateProjectInput,
  ProjectRecord,
  ProjectSetupResponse,
  ProjectsResponse,
  StartProjectSetupInput,
  UpdateProjectInput,
} from "../types.ts";
import { apiJson } from "./client.ts";

export function listProjects(signal?: AbortSignal): Promise<ProjectsResponse> {
  return apiJson<ProjectsResponse>("/projects", { signal });
}

export function getProject(projectId: string): Promise<{ project: ProjectRecord }> {
  return apiJson<{ project: ProjectRecord }>(`/projects/${encodeURIComponent(projectId)}`);
}

export function createProject(input: CreateProjectInput): Promise<{ project: ProjectRecord }> {
  return apiJson<{ project: ProjectRecord }>("/projects", { method: "POST", body: input });
}

/** Asks the computer whether it would link this directory; resolves to its canonical path. */
export function checkProjectWorkspace(
  daemonNodeId: string,
  workspaceHostPath: string,
  signal?: AbortSignal,
): Promise<{ workspaceHostPath: string }> {
  return apiJson<{ workspaceHostPath: string }>("/projects/workspace-check", {
    method: "POST",
    body: { daemonNodeId, workspaceHostPath },
    signal,
  });
}

export function updateProject(projectId: string, input: UpdateProjectInput): Promise<{ project: ProjectRecord }> {
  return apiJson<{ project: ProjectRecord }>(`/projects/${encodeURIComponent(projectId)}`, {
    method: "PATCH",
    body: input,
  });
}

export function getProjectSetup(projectId: string, signal?: AbortSignal): Promise<ProjectSetupResponse> {
  return apiJson<ProjectSetupResponse>(`/projects/${encodeURIComponent(projectId)}/setup`, { signal });
}

export function startProjectSetup(projectId: string, input: StartProjectSetupInput): Promise<{ project: ProjectRecord; threadId: string }> {
  return apiJson<{ project: ProjectRecord; threadId: string }>(`/projects/${encodeURIComponent(projectId)}/setup`, {
    method: "POST",
    body: input,
  });
}

export function archiveProject(projectId: string, expectedVersion: number): Promise<{ project: ProjectRecord }> {
  const query = new URLSearchParams({ expectedVersion: String(expectedVersion) });
  return apiJson<{ project: ProjectRecord }>(`/projects/${encodeURIComponent(projectId)}/archive?${query.toString()}`, {
    method: "POST",
  });
}

export function deleteProject(projectId: string, expectedVersion: number): Promise<{ deletedProjectId: string; workspaceCleanup: "queued" | "waiting_for_upgrade" | "kept"; cleanupCommandId: string | null }> {
  const query = new URLSearchParams({ expectedVersion: String(expectedVersion) });
  return apiJson(`/projects/${encodeURIComponent(projectId)}?${query.toString()}`, { method: "DELETE" });
}
