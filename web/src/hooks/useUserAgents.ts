"use client";

import { useMemo } from "react";
import { queryOptions, useQuery, type Query } from "@tanstack/react-query";
import { RELAY_POLL_INTERVALS_MS, ROSTER_STALE_TIME_MS } from "../lib/relayPolling";
import { getOwnAgent, getOwnAgentBadge, getTeamMemberChoices, listAgentSetup, listUserAgents, RelayApiError } from "../api";
import type { PrivateResponseCache } from "../api-client/client";
import { dedupeAgentsById } from "../lib/userAgents";
import { agentsForTeamComputer, teamComputerId } from "../lib/teamComputer";
import type { AgentBadge, AgentSetupResponse, AgentTeam, DefaultAgentOffer, TeamMemberChoicesResponse, UserAgent, UserAgentsResponse } from "../types";

export const USER_AGENTS_QUERY_KEY = "user-agents";
export const USER_AGENT_RECORD_QUERY_KEY = "user-agent-record";
const rosterValidators = new WeakMap<Query, PrivateResponseCache<UserAgentsResponse>>();
const recordValidators = new WeakMap<Query, PrivateResponseCache<{ agent: UserAgent }>>();
const setupValidators = new WeakMap<Query, PrivateResponseCache<AgentSetupResponse>>();
const teamMemberValidators = new WeakMap<Query, PrivateResponseCache<TeamMemberChoicesResponse>>();
const badgeValidators = new WeakMap<Query, PrivateResponseCache<{ agent: AgentBadge }>>();

export function useOwnAgentBadge(userId: string | undefined, agentId: string | null | undefined, enabled: boolean) {
  const query = useQuery({
    queryKey: [USER_AGENTS_QUERY_KEY, userId, "badge", agentId],
    enabled: Boolean(userId && agentId) && enabled,
    staleTime: ROSTER_STALE_TIME_MS,
    refetchInterval: RELAY_POLL_INTERVALS_MS.agents,
    queryFn: async ({ signal, client, queryKey }) => {
      const entry = client.getQueryCache().find({ queryKey, exact: true });
      const roster = client.getQueryState<UserAgentsResponse>([USER_AGENTS_QUERY_KEY, userId]);
      if (roster?.data && !roster.isInvalidated && roster.dataUpdatedAt >= (entry?.state.dataUpdatedAt ?? 0)
        && Date.now() - roster.dataUpdatedAt < ROSTER_STALE_TIME_MS) {
        const agent = roster.data.agents.find(item => item.id === agentId);
        if (agent) return agent;
      }
      const cache = (entry && badgeValidators.get(entry)) || {};
      if (entry) badgeValidators.set(entry, cache);
      try {
        return (await getOwnAgentBadge(agentId!, signal, cache)).agent ?? null;
      } catch (error) {
        if (error instanceof RelayApiError && error.status === 404) return null;
        throw error;
      }
    },
  });
  return query.data;
}

export function useTeamMemberChoices(team: AgentTeam, enabled: boolean) {
  return useQuery({
    queryKey: [USER_AGENTS_QUERY_KEY, team.ownerUserId, "team-member-choices", team.id,
      team.computerId, team.leadAgentId, [...team.memberAgentIds].sort()],
    queryFn: ({ signal, client, queryKey }) => {
      const roster = client.getQueryState<UserAgentsResponse>([USER_AGENTS_QUERY_KEY, team.ownerUserId]);
      const entry = client.getQueryCache().find({ queryKey, exact: true });
      if (roster?.data && !roster.isInvalidated && roster.dataUpdatedAt >= (entry?.state.dataUpdatedAt ?? 0)
        && Date.now() - roster.dataUpdatedAt < ROSTER_STALE_TIME_MS) {
        const agents = dedupeAgentsById(roster.data.agents);
        const computerId = teamComputerId(team, agents);
        return { computerId, agents: agentsForTeamComputer(agents, computerId, team.memberAgentIds) };
      }
      const cache = (entry && teamMemberValidators.get(entry)) || {};
      if (entry) teamMemberValidators.set(entry, cache);
      return getTeamMemberChoices(team, signal, cache);
    },
    enabled, staleTime: ROSTER_STALE_TIME_MS,
  });
}

export function userAgentRosterOptions(userId?: string) {
  return queryOptions({
    queryKey: [USER_AGENTS_QUERY_KEY, userId],
    queryFn: ({ signal, client, queryKey }) => {
      const entry = client.getQueryCache().find({ queryKey, exact: true });
      const cache = (entry && rosterValidators.get(entry)) || {};
      if (entry) rosterValidators.set(entry, cache);
      return listUserAgents(signal, true, { view: "summary", cache });
    },
    staleTime: ROSTER_STALE_TIME_MS,
  });
}

export function userAgentRecordOptions(agentId?: string) {
  return queryOptions({
    queryKey: [USER_AGENT_RECORD_QUERY_KEY, agentId],
    queryFn: ({ signal, client, queryKey }) => {
      const entry = client.getQueryCache().find({ queryKey, exact: true });
      const cache = (entry && recordValidators.get(entry)) || {};
      if (entry) recordValidators.set(entry, cache);
      return getOwnAgent(agentId!, signal, cache);
    },
    staleTime: ROSTER_STALE_TIME_MS,
  });
}

export function useAgentSetup(userId: string | undefined, enabled: boolean) {
  const query = useQuery({
    queryKey: [USER_AGENTS_QUERY_KEY, userId, "setup"],
    queryFn: ({ signal, client, queryKey }) => {
      const entry = client.getQueryCache().find({ queryKey, exact: true });
      const roster = client.getQueryState<UserAgentsResponse>([USER_AGENTS_QUERY_KEY, userId]);
      if (roster?.data && !roster.isInvalidated && roster.dataUpdatedAt >= (entry?.state.dataUpdatedAt ?? 0)
        && Date.now() - roster.dataUpdatedAt < ROSTER_STALE_TIME_MS) {
        return roster.data;
      }
      const cache = (entry && setupValidators.get(entry)) || {};
      if (entry) setupValidators.set(entry, cache);
      return listAgentSetup(signal, cache);
    },
    enabled: Boolean(userId) && enabled,
    staleTime: ROSTER_STALE_TIME_MS,
    refetchInterval: RELAY_POLL_INTERVALS_MS.agents,
  });
  return {
    agents: query.data?.view === "setup" ? query.data.onboardingAgents : query.data?.agents,
    get offers() {
      if (!query.data && !query.isError) return undefined;
      return query.data?.defaultAgentOffers ?? null;
    },
  };
}

export function useUserAgents(userId?: string, poll = false, enabled = true): {
  agents: UserAgent[];
  summarized: boolean;
  searchesInstructions: boolean;
  defaultAgentOffers: DefaultAgentOffer[] | null | undefined;
  isFetching: boolean;
  isSuccess: boolean;
  error: string | null;
  refetch: () => Promise<unknown>;
} {
  const query = useQuery({
    ...userAgentRosterOptions(userId),
    enabled: Boolean(userId) && enabled,
    // Every roster mutation invalidates this key, so the poll only has to
    // catch node-reported availability drift; the stale window lets the many
    // pages that mount this hook share one read instead of refetching.
    // AuthenticatedApp owns the timer; page observers reuse the same cache.
    refetchInterval: poll ? RELAY_POLL_INTERVALS_MS.agents : false,
  });
  const agents = useMemo(() => dedupeAgentsById(query.data?.agents ?? []), [query.data]);
  // Getters, not values: React Query re-renders a component for every result
  // field the component READ. Reading isFetching here on behalf of callers
  // that only want the list (App, every board) re-rendered the whole app on
  // each poll's start and end. Only a caller that reads it now pays.
  return {
    agents,
    get summarized() { return query.data?.view === "summary"; },
    get searchesInstructions() { return query.data?.searchesInstructions !== false; },
    get defaultAgentOffers() {
      if (!query.data && !query.isError) return undefined;
      return query.data?.defaultAgentOffers ?? null;
    },
    get isSuccess() { return query.isSuccess; },
    get isFetching() { return query.isFetching; },
    get error() { return query.error instanceof Error ? query.error.message : query.error ? String(query.error) : null; },
    refetch: query.refetch,
  };
}
