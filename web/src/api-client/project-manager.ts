import { apiJson } from "./client";
import type { AppliedManagerProposal, ApplyManagerInput, ProjectManagerResponse } from "../domain-types/project-manager";

const path = (id: string) => `/projects/${encodeURIComponent(id)}/manager`;
export function getProjectManager(id: string, signal?: AbortSignal): Promise<ProjectManagerResponse> {
  return apiJson(path(id), { signal });
}
export function setProjectManager(id: string, agentId: string, expectedVersion: number): Promise<ProjectManagerResponse> {
  return apiJson(path(id), { method: "PUT", body: { agentId, expectedVersion } });
}
export function sendManagerMessage(id: string, body: { text: string; idempotencyKey: string }): Promise<{threadId: string}> {
  return apiJson(`${path(id)}/messages`, { method: "POST", body });
}
export function applyManagerProposal(id: string, proposalId: string, body: ApplyManagerInput): Promise<AppliedManagerProposal> {
  return apiJson(`${path(id)}/proposals/${encodeURIComponent(proposalId)}/apply`, { method: "POST", body });
}
export function dismissManagerProposal(id: string, proposalId: string): Promise<unknown> {
  return apiJson(`${path(id)}/proposals/${encodeURIComponent(proposalId)}/dismiss`, { method: "POST", body: {} });
}
