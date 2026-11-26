import type {
  AgentBadge,
  AgentName,
  AgentPlacement,
  AgentRole,
  AgentRoleLevel,
  AgentSetupResponse,
  AgentTeam,
  AgentTeamsResponse,
  CompactTeamSummaryResponse,
  CreateAgentInput,
  CreateAgentResponse,
  DefaultAgentOffer,
  RelaySession,
  TeamMutationInput,
  TeamRosterResponse,
  TeamMemberConfigPatch,
  TeamMemberChoicesResponse,
  TeamWorkflow,
  WorkflowMutationInput,
  UserAgent,
  UserAgentsResponse,
} from "../types.ts";
import { apiJson, privateConditionalJson, RelayApiError, type PrivateResponseCache } from "./client.ts";
import { applyTeamMemberConfigPatch } from "../lib/teamForm.ts";
import { agentsForTeamComputer, teamComputerId } from "../lib/teamComputer.ts";

export async function getTeamMemberChoices(
  team: AgentTeam, signal?: AbortSignal, cache?: PrivateResponseCache<TeamMemberChoicesResponse>,
): Promise<TeamMemberChoicesResponse> {
  try {
    return await privateConditionalJson(`/teams/${encodeURIComponent(team.id)}/member-choices`, signal, cache);
  } catch (error) {
    if (!(error instanceof RelayApiError && error.status === 404
      && (error.code === "Not found." || error.code === "Not Found"))) throw error;
  }
  const { agents } = await listUserAgents(signal, false, { view: "summary" });
  const computerId = teamComputerId(team, agents);
  return { computerId, agents: agentsForTeamComputer(agents, computerId, team.memberAgentIds) };
}

export function listUserAgents(signal?: AbortSignal, includeDefaultOffers = false, options?: {
  view: "summary"; cache?: PrivateResponseCache<UserAgentsResponse>;
}): Promise<UserAgentsResponse> {
  const params = new URLSearchParams();
  if (includeDefaultOffers) params.set("include", "default-offers");
  if (options) params.set("view", options.view);
  const query = params.toString();
  return privateConditionalJson(query ? `/agents?${query}` : "/agents", signal, options?.cache);
}

export function listAgentSetup(signal?: AbortSignal, cache?: PrivateResponseCache<AgentSetupResponse>): Promise<AgentSetupResponse> {
  return privateConditionalJson("/agents?include=default-offers&view=setup", signal, cache);
}

export function getOwnAgent(agentId: string, signal?: AbortSignal, cache?: PrivateResponseCache<{ agent: UserAgent }>): Promise<{ agent: UserAgent }> {
  return privateConditionalJson(`/agents/${encodeURIComponent(agentId)}`, signal, cache);
}

export function getOwnAgentBadge(
  agentId: string, signal?: AbortSignal, cache?: PrivateResponseCache<{ agent: AgentBadge }>,
): Promise<{ agent: AgentBadge }> {
  return privateConditionalJson(`/agents/${encodeURIComponent(agentId)}?view=badge`, signal, cache);
}

export function searchOwnAgents(query: string, blurbs: Record<string, string>, signal?: AbortSignal): Promise<{ agentIds: string[] }> {
  const params = new URLSearchParams({ view: "matches", q: query });
  for (const [kind, blurb] of Object.entries(blurbs)) params.set(`blurb.${kind}`, blurb);
  return apiJson(`/agents?${params}`, { signal });
}

export function createAgent(body: CreateAgentInput): Promise<CreateAgentResponse> {
  return apiJson<CreateAgentResponse>("/agents", { method: "POST", body });
}

export function listControlPanelAgents(userId?: string, signal?: AbortSignal): Promise<UserAgentsResponse> {
  const query = userId ? `?userId=${encodeURIComponent(userId)}` : "";
  return apiJson<UserAgentsResponse>(`/admin/agents${query}`, { signal });
}

const expandedTeamRosters = new WeakMap<CompactTeamSummaryResponse, AgentTeamsResponse>();

export async function listTeams(signal?: AbortSignal, options?: {
  view: "summary"; cache?: PrivateResponseCache<TeamRosterResponse>;
}): Promise<AgentTeamsResponse> {
  const response = await privateConditionalJson<TeamRosterResponse>(
    options ? `/teams?view=${options.view}&format=compact` : "/teams", signal, options?.cache,
  );
  if (!("memberDirectory" in response)) return response;
  const cached = expandedTeamRosters.get(response);
  if (cached) return cached;
  const directory = new Map(response.memberDirectory.map(member => [member.id, member]));
  const result: AgentTeamsResponse = {
    view: response.view,
    teams: response.teams.map(team => {
      const members = team.memberAgentIds.flatMap(agentId => {
        const member = directory.get(agentId);
        return member ? [member] : [];
      });
      return {
        ...team, members, lead: members.find(member => member.id === team.leadAgentId) ?? null,
        workflowOptions: [...response.predefinedWorkflows, ...team.workflowOptions],
      };
    }),
  };
  expandedTeamRosters.set(response, result);
  return result;
}

export function getOwnTeam(teamId: string, signal?: AbortSignal, cache?: PrivateResponseCache<{ team: AgentTeam }>): Promise<{ team: AgentTeam }> {
  return privateConditionalJson(`/teams/${encodeURIComponent(teamId)}?view=preview`, signal, cache);
}

export function createTeam(input: TeamMutationInput): Promise<{ team: AgentTeam }> {
  return apiJson<{ team: AgentTeam }>("/teams", { method: "POST", body: input });
}

export function updateTeam(teamId: string, input: Partial<TeamMutationInput>): Promise<{ team: AgentTeam }> {
  return apiJson<{ team: AgentTeam }>(`/teams/${encodeURIComponent(teamId)}?view=preview`, {
    method: "PATCH",
    body: input,
  });
}

type TeamMemberUpdate = {
  teamId: string; agentId: string; baseVersion: number; version: number;
  updatedAt: string; fields: TeamMemberConfigPatch;
};

export async function updateTeamMemberConfig(team: AgentTeam, agentId: string, fields: TeamMemberConfigPatch): Promise<{ team: AgentTeam; baseVersion?: number }> {
  let update: TeamMemberUpdate;
  try {
    ({ teamMemberUpdate: update } = await apiJson<{ teamMemberUpdate: TeamMemberUpdate }>(
      `/teams/${encodeURIComponent(team.id)}/members/${encodeURIComponent(agentId)}`,
      { method: "PATCH", body: fields },
    ));
  } catch (error) {
    if (!(error instanceof RelayApiError) || !(
      (error.status === 404 && error.code === "Not Found")
      || (error.status === 405 && error.code === "Method Not Allowed")
    )) throw error;
    // Older backends can still write the complete member config map.
    const memberConfigs = team.memberConfigs ?? {};
    return updateTeam(team.id, { memberConfigs: {
      ...memberConfigs, [agentId]: applyTeamMemberConfigPatch(memberConfigs[agentId] ?? {}, fields),
    } });
  }
  if (update?.teamId !== team.id || update.agentId !== agentId
    || update.baseVersion !== team.version || update.version !== update.baseVersion + 1) {
    return getOwnTeam(team.id);
  }
  return {
    baseVersion: update.baseVersion,
    team: {
      ...team, version: update.version, updatedAt: update.updatedAt,
      memberConfigs: {
        ...team.memberConfigs,
        [agentId]: applyTeamMemberConfigPatch(team.memberConfigs?.[agentId] ?? {}, update.fields),
      },
    },
  };
}

/** Start a Project workflow Team in a new Project Thread. Keep `requestId`
 *  for retries: the same id and goal return the original Thread. */
export function startWorkflowRun(
  teamId: string,
  input: { requestId: string; taskGoal: string },
): Promise<RelaySession> {
  return apiJson<RelaySession>(`/teams/${encodeURIComponent(teamId)}/workflow-runs`, {
    method: "POST",
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
  delegationAgentIds?: string[] | null;
  displayName?: string;
  instructions?: string;
  /** `{}` returns the agent to its runtime's default model. */
  modelPolicy?: { model?: string };
  /** The agent's own role; a team may assign its member a different one. */
  defaultRole?: AgentRole;
  /** Optional seniority level ("junior" or "senior"); null clears it. */
  roleLevel?: AgentRoleLevel | null;
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

/** A connected computer's ready runtimes that have never had an agent there
    and whose default agent the person has not declined. */
export type { DefaultAgentOffer } from "../domain-types/agents.ts";

export interface DefaultAgentAnswer {
  computerId: string;
  executorKinds: AgentName[];
}

export function listDefaultAgentOffers(signal?: AbortSignal): Promise<{ offers: DefaultAgentOffer[] }> {
  return apiJson<{ offers: DefaultAgentOffer[] }>("/agents/default-offers", { signal });
}

/** Create one default agent per runtime; a runtime already answered is skipped. */
export function acceptDefaultAgents(answer: DefaultAgentAnswer): Promise<{ agents: UserAgent[] }> {
  return apiJson<{ agents: UserAgent[] }>("/agents/default-offers/accept", { method: "POST", body: answer });
}

/** Remember that the person does not want these defaults, so they are not asked again. */
export function declineDefaultAgents(answer: DefaultAgentAnswer): Promise<{ ok: true }> {
  return apiJson<{ ok: true }>("/agents/default-offers/decline", { method: "POST", body: answer });
}


export function saveTeamWorkflow(teamId: string, input: WorkflowMutationInput, workflowId?: string): Promise<{ workflow: TeamWorkflow }> {
  const path = `/teams/${encodeURIComponent(teamId)}/workflows`;
  return apiJson(workflowId ? `${path}/${encodeURIComponent(workflowId)}` : path, {
    method: workflowId ? "PATCH" : "POST", body: input,
  });
}

export function deleteTeamWorkflow(teamId: string, workflowId: string): Promise<{ workflows: TeamWorkflow[] }> {
  return apiJson(`/teams/${encodeURIComponent(teamId)}/workflows/${encodeURIComponent(workflowId)}`, { method: "DELETE" });
}

export function startTeamWorkflow(teamId: string, workflowId: string, input: { requestId: string; taskGoal: string }): Promise<RelaySession> {
  return apiJson(`/teams/${encodeURIComponent(teamId)}/workflows/${encodeURIComponent(workflowId)}/runs`, { method: "POST", body: input });
}
