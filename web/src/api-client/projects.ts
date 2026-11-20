import type {
  CreateProjectInput,
  ProjectMember,
  ProjectListItem,
  ProjectRailItem,
  ProjectRecord,
  ApplySetupTasksInput,
  ProjectSetupResponse,
  ProjectsResponse,
  RelayTask,
  StartProjectSetupInput,
  UpdateProjectInput,
} from "../types.ts";
import { apiJson, privateConditionalJson, type PrivateResponseCache } from "./client.ts";

export function listProjects(signal?: AbortSignal, cache?: PrivateResponseCache<ProjectsResponse>): Promise<ProjectsResponse> {
  return privateConditionalJson("/projects?view=directory", signal, cache);
}

export function listProjectIndex(
  signal?: AbortSignal, cache?: PrivateResponseCache<{ projects: ProjectRailItem[] }>,
): Promise<{ projects: ProjectRailItem[] }> {
  return privateConditionalJson("/projects?view=index", signal, cache);
}

export function getProjectDirectoryEntry(
  projectId: string, signal?: AbortSignal, cache?: PrivateResponseCache<{ project: ProjectListItem }>,
): Promise<{ project: ProjectListItem }> {
  return privateConditionalJson(`/projects/${encodeURIComponent(projectId)}?view=directory`, signal, cache);
}

export function getProject(projectId: string, signal?: AbortSignal, cache?: PrivateResponseCache<{ project: ProjectRecord }>): Promise<{ project: ProjectRecord }> {
  return privateConditionalJson(`/projects/${encodeURIComponent(projectId)}`, signal, cache);
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

type ProjectMemberUpdate = Pick<ProjectRecord, "id" | "version" | "leadAgentId" | "managerAgentId" | "updatedAt"> & {
  baseVersion: number;
  memberChanges: (
    | { op: "remove"; agentId: string }
    | { op: "add"; agentId: string; fields: Omit<ProjectMember, "agentId"> }
    | { op: "update"; agentId: string; fields: Partial<Omit<ProjectMember, "agentId" | "instructions" | "projectManager">> & {
      instructions?: string | null; projectManager?: boolean | null;
    } }
  )[];
};

function applyProjectMemberUpdate(base: ProjectRecord, update: ProjectMemberUpdate): ProjectRecord | undefined {
  const { baseVersion, memberChanges, ...saved } = update;
  if (saved.id !== base.id || baseVersion !== base.version || saved.version !== baseVersion + 1) return undefined;
  const members = new Map(base.members.map(member => [member.agentId, member]));
  for (const change of memberChanges) {
    if (change.op === "remove") {
      if (!members.delete(change.agentId)) return undefined;
    } else if (change.op === "add") {
      if (members.has(change.agentId)) return undefined;
      members.set(change.agentId, { agentId: change.agentId, ...change.fields });
    } else {
      const previous = members.get(change.agentId);
      if (!previous) return undefined;
      const { instructions, projectManager, ...fields } = change.fields;
      const member = { ...previous, ...fields };
      if (instructions === null) delete member.instructions;
      else if (instructions !== undefined) member.instructions = instructions;
      if (projectManager === null) delete member.projectManager;
      else if (projectManager !== undefined) member.projectManager = projectManager;
      members.set(change.agentId, member);
    }
  }
  return { ...base, ...saved, members: [...members.values()] };
}

export async function updateProject(projectId: string, input: UpdateProjectInput, baseProject?: ProjectRecord): Promise<{ project: ProjectRecord }> {
  const base = baseProject?.id === projectId && baseProject.version === input.expectedVersion ? baseProject : undefined;
  const query = base ? "?view=member-update" : "";
  const result = await apiJson<{ project: ProjectRecord } | { projectMemberUpdate: ProjectMemberUpdate }>(`/projects/${encodeURIComponent(projectId)}${query}`, {
    method: "PATCH",
    body: input,
  });
  if ("project" in result) return result;
  const project = base && applyProjectMemberUpdate(base, result.projectMemberUpdate);
  // The PATCH has committed. If this snapshot cannot apply the update, read
  // the current Project instead of retrying the write.
  return project ? { project } : getProject(projectId);
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

/** Create a drafted proposal's tasks with their prerequisites. Retrying is
 *  safe: tasks already created from the draft are not created again. */
export function applySetupTasks(
  projectId: string,
  input: ApplySetupTasksInput,
): Promise<{ project: ProjectRecord; tasks: RelayTask[] }> {
  return apiJson<{ project: ProjectRecord; tasks: RelayTask[] }>(
    `/projects/${encodeURIComponent(projectId)}/setup/tasks`,
    { method: "POST", body: input },
  );
}

export function archiveProject(projectId: string, expectedVersion: number): Promise<{ project: ProjectRecord }> {
  const query = new URLSearchParams({ expectedVersion: String(expectedVersion) });
  return apiJson<{ project: ProjectRecord }>(`/projects/${encodeURIComponent(projectId)}/archive?${query.toString()}`, {
    method: "POST",
  });
}

/** Reopen an archived project. A live project with the same name refuses it
 *  with `project_name_taken`. */
export function unarchiveProject(projectId: string, expectedVersion: number): Promise<{ project: ProjectRecord }> {
  const query = new URLSearchParams({ expectedVersion: String(expectedVersion) });
  return apiJson<{ project: ProjectRecord }>(`/projects/${encodeURIComponent(projectId)}/unarchive?${query.toString()}`, {
    method: "POST",
  });
}

export type ProjectWorkspaceCleanup = "queued" | "waiting_for_upgrade" | "waiting_for_computer" | "orphaned" | "kept";

export interface ProjectDeletion {
  deletedProjectId: string;
  workspaceCleanup: ProjectWorkspaceCleanup;
  cleanupCommandId: string | null;
  /** Tasks outside the project that lost a thread but were kept. */
  detachedTaskIds?: string[];
}

export function deleteProject(projectId: string, expectedVersion: number): Promise<ProjectDeletion> {
  const query = new URLSearchParams({ expectedVersion: String(expectedVersion) });
  return apiJson(`/projects/${encodeURIComponent(projectId)}?${query.toString()}`, { method: "DELETE" });
}
