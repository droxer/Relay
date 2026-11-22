import { apiJson } from "./client";
import type { AppliedManagerProposal, ApplyManagerInput, ManagerProposal, ProjectManagerResponse } from "../domain-types/project-manager";

const path = (id: string) => `/projects/${encodeURIComponent(id)}/manager`;
export function getProjectManager(id: string, signal?: AbortSignal): Promise<ProjectManagerResponse> {
  return apiJson(path(id), { signal });
}
export function listThreadProposals(projectId: string, threadId: string, signal?: AbortSignal): Promise<{ proposals: ManagerProposal[] }> {
  return apiJson(`${path(projectId)}/proposals?${new URLSearchParams({ threadId })}`, { signal });
}
export function setProjectManager(id: string, agentId: string, expectedVersion: number): Promise<ProjectManagerResponse> {
  return apiJson(path(id), { method: "PUT", body: { agentId, expectedVersion } });
}
/** Starts a new Project Conversation with the current lead as its first Agent. */
export function openProjectLeadConversation(id: string): Promise<{ threadId: string; agentId: string }> {
  return apiJson(`${path(id)}/conversation`, { method: "POST", body: {} });
}
export function applyManagerProposal(id: string, proposalId: string, body: ApplyManagerInput): Promise<AppliedManagerProposal> {
  return apiJson(`${path(id)}/proposals/${encodeURIComponent(proposalId)}/apply`, { method: "POST", body });
}
export function dismissManagerProposal(id: string, proposalId: string): Promise<unknown> {
  return apiJson(`${path(id)}/proposals/${encodeURIComponent(proposalId)}/dismiss`, { method: "POST", body: {} });
}
