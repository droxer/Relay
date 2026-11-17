import type { AgentTeam, RelaySession, Workflow, WorkflowMutationInput } from "../types.ts";
import { apiJson } from "./client.ts";

export function listWorkflows(projectId?: string, signal?: AbortSignal): Promise<{ workflows: Workflow[] }> {
  return apiJson(`/workflows${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""}`, { signal });
}
export function saveWorkflow(input: WorkflowMutationInput, workflowId?: string): Promise<{ workflow: Workflow }> {
  return apiJson(workflowId ? `/workflows/${encodeURIComponent(workflowId)}` : "/workflows", {
    method: workflowId ? "PATCH" : "POST", body: input,
  });
}
export function deleteWorkflow(workflowId: string): Promise<{ deletedWorkflowId: string }> {
  return apiJson(`/workflows/${encodeURIComponent(workflowId)}`, { method: "DELETE" });
}
export function startProjectWorkflow(workflowId: string, input: { requestId: string; taskGoal: string; teamId?: string; projectId?: string }): Promise<RelaySession> {
  return apiJson(`/workflows/${encodeURIComponent(workflowId)}/runs`, { method: "POST", body: input });
}
export function linkTeamWorkflow(teamId: string, workflowId: string, linked = true): Promise<{ team: AgentTeam }> {
  return apiJson(`/teams/${encodeURIComponent(teamId)}/workflows/${encodeURIComponent(workflowId)}/link`, {
    method: linked ? "PUT" : "DELETE", ...(linked ? { body: {} } : {}),
  });
}
export function setTeamProjectWorkflow(teamId: string, projectId: string, workflowId: string | null): Promise<{ team: AgentTeam }> {
  return apiJson(`/teams/${encodeURIComponent(teamId)}/workflow-defaults/${encodeURIComponent(projectId)}`, {
    method: workflowId ? "PUT" : "DELETE", ...(workflowId ? { body: { workflowId } } : {}),
  });
}
