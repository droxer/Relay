import type { AgentTeam, ProjectWorkflowChoice, RelaySession, TeamWorkflowPreview, Workflow, WorkflowDraftUpdate, WorkflowMutationInput, WorkflowPreview, WorkflowStep, WorkflowStepChanges } from "../types.ts";
import { teamWorkflowPreviews } from "../lib/workflowSelection.ts";
import { apiJson, privateConditionalJson, RelayApiError, type PrivateResponseCache } from "./client.ts";
import { listProjects } from "./projects.ts";

export type WorkflowChoicesResponse = { workflows: (ProjectWorkflowChoice | Workflow)[] };
export type WorkflowPreviewsResponse = { workflows: WorkflowPreview[]; view?: "preview" };
export type WorkflowNameResponse = { workflow: Pick<Workflow, "id" | "name"> };
export type TeamWorkflowChoicesResponse = {
  workflows: Pick<ProjectWorkflowChoice, "id" | "name" | "projectId">[];
  projects: { id: string; name: string }[];
};

export function listWorkflowPreviews(
  projectId: string, signal?: AbortSignal, cache?: PrivateResponseCache<WorkflowPreviewsResponse>,
): Promise<WorkflowPreviewsResponse> {
  const query = new URLSearchParams({ view: "preview", projectId });
  return privateConditionalJson(`/workflows?${query}`, signal, cache);
}

export async function listProjectWorkflowChoices(
  projectId?: string, signal?: AbortSignal, cache?: PrivateResponseCache<WorkflowChoicesResponse>,
): Promise<{ workflows: ProjectWorkflowChoice[] }> {
  const query = new URLSearchParams({ view: "choices" });
  if (projectId) query.set("projectId", projectId);
  const { workflows } = await privateConditionalJson<WorkflowChoicesResponse>(`/workflows?${query}`, signal, cache);
  // Older backends return the complete catalog when they ignore the view.
  return { workflows: workflows.flatMap(workflow => {
    if ("stepAgentIds" in workflow) return [workflow];
    if (!workflow.projectId || workflow.ownerTeamId) return [];
    return [{
      id: workflow.id, name: workflow.name, projectId: workflow.projectId, enabled: workflow.enabled,
      stepAgentIds: [...new Set(workflow.workflowSteps.map(step => step.agentId))],
    }];
  }) };
}

export async function getTeamWorkflowChoices(
  team: AgentTeam, signal?: AbortSignal, cache?: PrivateResponseCache<TeamWorkflowChoicesResponse>,
): Promise<TeamWorkflowChoicesResponse> {
  try {
    return await privateConditionalJson(`/teams/${encodeURIComponent(team.id)}/workflow-choices`, signal, cache);
  } catch (error) {
    if (!(error instanceof RelayApiError && error.status === 404
      && (error.code === "Not found." || error.code === "Not Found"))) throw error;
  }
  const { projects } = await listProjects(signal);
  const eligible = new Set(projects.filter(project =>
    project.enabled && !project.archivedAt && project.computerId === team.computerId).map(project => project.id));
  const catalog = eligible.size ? (await listProjectWorkflowChoices(undefined, signal)).workflows : [];
  const workflows = catalog.filter(workflow => workflow.enabled && eligible.has(workflow.projectId)
    && workflow.stepAgentIds.every(id => team.memberAgentIds.includes(id)))
    .map(({ id, name, projectId }) => ({ id, name, projectId }));
  const used = new Set([...workflows, ...teamWorkflowPreviews(team)].map(item => item.projectId));
  return { workflows, projects: projects.filter(project => used.has(project.id)).map(({ id, name }) => ({ id, name })) };
}

export function getWorkflow(workflowId: string, signal?: AbortSignal, cache?: PrivateResponseCache<{ workflow: Workflow }>): Promise<{ workflow: Workflow }> {
  return privateConditionalJson(`/workflows/${encodeURIComponent(workflowId)}`, signal, cache);
}

export function getWorkflowName(workflowId: string, signal?: AbortSignal, cache?: PrivateResponseCache<WorkflowNameResponse>): Promise<WorkflowNameResponse> {
  return privateConditionalJson(`/workflows/${encodeURIComponent(workflowId)}?view=name`, signal, cache);
}
export function saveWorkflow(input: WorkflowMutationInput, workflowId?: undefined): Promise<{ workflow: Workflow }>;
export function saveWorkflow(input: Partial<WorkflowMutationInput>, workflowId: string): Promise<{ workflow: Workflow }>;
export function saveWorkflow(input: Partial<WorkflowMutationInput>, workflowId?: string): Promise<{ workflow: Workflow }> {
  return apiJson(workflowId ? `/workflows/${encodeURIComponent(workflowId)}` : "/workflows", {
    method: workflowId ? "PATCH" : "POST", body: input,
  });
}

type WorkflowUpdate = Pick<Workflow, "id" | "name" | "updatedAt"> & {
  baseVersion: number; version: number; workflowStepChanges: WorkflowStepChanges; teamLinkUnchanged?: true;
};
export type WorkflowSaveResponse = { workflow: Workflow; teamLinkUnchanged?: true };

function applyWorkflowUpdate(base: Workflow, update: Omit<WorkflowUpdate, "teamLinkUnchanged">): Workflow | undefined {
  const { baseVersion, workflowStepChanges, ...saved } = update;
  if (saved.id !== base.id || baseVersion !== base.version || saved.version !== baseVersion + 1) return undefined;
  const previous = new Map(base.workflowSteps.map(step => [step.id, step]));
  const fields = new Map(Object.entries(workflowStepChanges.byId ?? {}));
  const steps: WorkflowStep[] = [];
  for (const id of workflowStepChanges.order ?? previous.keys()) {
    const current = previous.get(id);
    const fieldsForStep = fields.get(id);
    if (!fieldsForStep && current) {
      steps.push(current);
      continue;
    }
    const { kind = current?.kind, expectedOutputs = current?.expectedOutputs, ...patch } = fieldsForStep ?? {};
    const step = { ...current, ...patch, id };
    if (typeof step.name !== "string" || typeof step.agentId !== "string" || typeof step.instructions !== "string"
      || !Array.isArray(step.acceptanceCriteria) || typeof step.requiresApproval !== "boolean") return undefined;
    steps.push({
      id, name: step.name, agentId: step.agentId, instructions: step.instructions,
      acceptanceCriteria: step.acceptanceCriteria, requiresApproval: step.requiresApproval,
      ...(kind == null ? {} : { kind }),
      ...(expectedOutputs == null ? {} : { expectedOutputs }),
    });
  }
  return { ...base, ...saved, workflowSteps: steps };
}

export async function updateWorkflowDraft(base: Workflow, changes: WorkflowDraftUpdate): Promise<WorkflowSaveResponse> {
  const result = await apiJson<{ workflowUpdate: WorkflowUpdate } | { workflow: Workflow }>(
    `/workflows/${encodeURIComponent(base.id)}?view=update`,
    { method: "PATCH", body: { ...changes, expectedVersion: base.version } },
  );
  if ("workflow" in result) return result;
  const { teamLinkUnchanged, ...update } = result.workflowUpdate;
  const workflow = applyWorkflowUpdate(base, update);
  return workflow ? { workflow, ...(teamLinkUnchanged ? { teamLinkUnchanged } : {}) } : getWorkflow(base.id);
}

export function deleteWorkflow(workflowId: string): Promise<{ deletedWorkflowId: string }> {
  return apiJson(`/workflows/${encodeURIComponent(workflowId)}`, { method: "DELETE" });
}
export function startProjectWorkflow(workflowId: string, input: { requestId: string; taskGoal: string; teamId?: string; projectId?: string }): Promise<RelaySession> {
  return apiJson(`/workflows/${encodeURIComponent(workflowId)}/runs`, { method: "POST", body: input });
}
export function linkTeamWorkflow(teamId: string, workflowId: string, linked = true): Promise<TeamWorkflowWriteResponse> {
  return apiJson(`/teams/${encodeURIComponent(teamId)}/workflows/${encodeURIComponent(workflowId)}/link?view=preview&format=delta`, {
    method: linked ? "PUT" : "DELETE", ...(linked ? { body: {} } : {}),
  });
}
type TeamWorkflowRevision = {
  teamId: string;
  baseVersion: number;
  version: number;
  updatedAt: string;
};

type TeamWorkflowDefaultUpdate = TeamWorkflowRevision & {
  defaultWorkflowId: string;
  legacyWorkflow: boolean;
  projectDefault?: { projectId: string; workflowId: string | null };
};

export type TeamWorkflowLinkUpdate = TeamWorkflowRevision & {
  workflowId: string;
  workflow: TeamWorkflowPreview | null;
  workflowOrder: { id: string; version: number }[];
};

export type TeamWorkflowUpdate = TeamWorkflowDefaultUpdate | TeamWorkflowLinkUpdate;
export type TeamWorkflowWriteResponse = { team: AgentTeam } | { teamWorkflowUpdate: TeamWorkflowUpdate };

export function setTeamDefaultWorkflow(teamId: string, workflowId: string): Promise<TeamWorkflowWriteResponse> {
  return apiJson(`/teams/${encodeURIComponent(teamId)}?view=preview&format=delta`, {
    method: "PATCH", body: { defaultWorkflowId: workflowId },
  });
}

export function setTeamProjectWorkflow(teamId: string, projectId: string, workflowId: string | null): Promise<TeamWorkflowWriteResponse> {
  return apiJson(`/teams/${encodeURIComponent(teamId)}/workflow-defaults/${encodeURIComponent(projectId)}?view=preview&format=delta`, {
    method: workflowId ? "PUT" : "DELETE", ...(workflowId ? { body: { workflowId } } : {}),
  });
}
