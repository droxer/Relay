import type {
  AgentPlacement,
  AgentRole,
  AgentTeam,
  AgentTeamsResponse,
  CreateAgentInput,
  CreateAgentResponse,
  TeamMutationInput,
  UserAgent,
  UserAgentsResponse,
} from "../types.ts";
import { apiJson } from "./client.ts";

export function listUserAgents(signal?: AbortSignal): Promise<UserAgentsResponse> {
  return apiJson<UserAgentsResponse>("/agents", { signal });
}

export function createAgent(body: CreateAgentInput): Promise<CreateAgentResponse> {
  return apiJson<CreateAgentResponse>("/agents", { method: "POST", body });
}

export function listControlPanelAgents(userId?: string, signal?: AbortSignal): Promise<UserAgentsResponse> {
  const query = userId ? `?userId=${encodeURIComponent(userId)}` : "";
  return apiJson<UserAgentsResponse>(`/admin/agents${query}`, { signal });
}

export function listTeams(signal?: AbortSignal): Promise<AgentTeamsResponse> {
  return apiJson<AgentTeamsResponse>("/teams", { signal });
}

export function createTeam(input: TeamMutationInput): Promise<{ team: AgentTeam }> {
  return apiJson<{ team: AgentTeam }>("/teams", { method: "POST", body: input });
}

export function updateTeam(teamId: string, input: Partial<TeamMutationInput>): Promise<{ team: AgentTeam }> {
  return apiJson<{ team: AgentTeam }>(`/teams/${encodeURIComponent(teamId)}`, {
    method: "PATCH",
    body: input,
  });
}

export function deleteTeam(teamId: string): Promise<{ team: AgentTeam }> {
  return apiJson<{ team: AgentTeam }>(`/teams/${encodeURIComponent(teamId)}`, { method: "DELETE" });
}

export function getControlPanelAgent(agentId: string, signal?: AbortSignal): Promise<{ agent: UserAgent }> {
  return apiJson<{ agent: UserAgent }>(`/admin/agents/${encodeURIComponent(agentId)}`, { signal });
}

export type UserAgentMetaPatch = {
  displayName?: string;
  instructions?: string;
  /** `{}` returns the agent to its runtime's default model. */
  modelPolicy?: { model?: string };
  /** null clears the role, so an agent can go back to no specialization. */
  defaultRole?: AgentRole | null;
};

export type UserAgentAdminPatch = UserAgentMetaPatch & {
  enabled?: boolean;
};

export function updateOwnUserAgent(
  agentId: string,
  patch: UserAgentMetaPatch,
): Promise<{ agent: UserAgent }> {
  return apiJson<{ agent: UserAgent }>(`/agents/${encodeURIComponent(agentId)}`, {
    method: "PATCH",
    body: patch,
  });
}

export function updateUserAgent(
  agentId: string,
  patch: UserAgentAdminPatch,
): Promise<{ agent: UserAgent }> {
  return apiJson<{ agent: UserAgent }>(`/admin/agents/${encodeURIComponent(agentId)}`, {
    method: "PATCH",
    body: patch,
  });
}

export function deleteOwnUserAgent(agentId: string): Promise<{ agent: UserAgent }> {
  return apiJson<{ agent: UserAgent }>(`/agents/${encodeURIComponent(agentId)}`, {
    method: "DELETE",
  });
}

export function deleteUserAgent(agentId: string): Promise<{ agent: UserAgent }> {
  return apiJson<{ agent: UserAgent }>(`/admin/agents/${encodeURIComponent(agentId)}`, {
    method: "DELETE",
  });
}

export function updateAgentProfileImage(
  agentId: string,
  dataUrl: string,
): Promise<{ agent: UserAgent }> {
  return apiJson<{ agent: UserAgent }>(
    `/profile-images/agents/${encodeURIComponent(agentId)}`,
    { method: "PUT", body: { dataUrl }, versioned: false },
  );
}

export function selectAgentProfilePreset(
  agentId: string,
  presetUrl: string,
): Promise<{ agent: UserAgent }> {
  return apiJson<{ agent: UserAgent }>(
    `/profile-images/agents/${encodeURIComponent(agentId)}`,
    { method: "PUT", body: { presetUrl }, versioned: false },
  );
}

export function deleteAgentProfileImage(
  agentId: string,
): Promise<{ agent: UserAgent }> {
  return apiJson<{ agent: UserAgent }>(
    `/profile-images/agents/${encodeURIComponent(agentId)}`,
    { method: "DELETE", versioned: false },
  );
}

export function updateTeamProfileImage(
  teamId: string,
  dataUrl: string,
): Promise<{ team: AgentTeam }> {
  return apiJson<{ team: AgentTeam }>(
    `/profile-images/teams/${encodeURIComponent(teamId)}`,
    { method: "PUT", body: { dataUrl }, versioned: false },
  );
}

export function selectTeamProfilePreset(
  teamId: string,
  presetUrl: string,
): Promise<{ team: AgentTeam }> {
  return apiJson<{ team: AgentTeam }>(
    `/profile-images/teams/${encodeURIComponent(teamId)}`,
    { method: "PUT", body: { presetUrl }, versioned: false },
  );
}

export function deleteTeamProfileImage(
  teamId: string,
): Promise<{ team: AgentTeam }> {
  return apiJson<{ team: AgentTeam }>(
    `/profile-images/teams/${encodeURIComponent(teamId)}`,
    { method: "DELETE", versioned: false },
  );
}

export function deleteAgentPlacement(placementId: string): Promise<{ placement: AgentPlacement }> {
  return apiJson<{ placement: AgentPlacement }>(`/admin/agent-placements/${encodeURIComponent(placementId)}`, {
    method: "DELETE",
  });
}
