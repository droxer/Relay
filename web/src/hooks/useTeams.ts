"use client";

import { queryOptions, useQuery, type Query } from "@tanstack/react-query";
import { RELAY_POLL_INTERVALS_MS, ROSTER_STALE_TIME_MS } from "../lib/relayPolling";
import { getOwnTeam, listTeams } from "../api";
import type { PrivateResponseCache } from "../api-client/client";
import type { AgentTeam, TeamRosterResponse } from "../types";

export const TEAMS_QUERY_KEY = "teams";
export const TEAM_RECORD_QUERY_KEY = "team-record";
const EMPTY_TEAMS: AgentTeam[] = [];
const rosterValidators = new WeakMap<Query, PrivateResponseCache<TeamRosterResponse>>();
const recordValidators = new WeakMap<Query, PrivateResponseCache<{ team: AgentTeam }>>();

export function teamRecordKey(userId?: string, teamId?: string) {
  return [TEAM_RECORD_QUERY_KEY, userId, teamId] as const;
}

export function teamRecordOptions(userId?: string, teamId?: string) {
  return queryOptions({
    queryKey: teamRecordKey(userId, teamId),
    queryFn: ({ signal, client, queryKey }) => {
      const entry = client.getQueryCache().find({ queryKey, exact: true });
      const cache = (entry && recordValidators.get(entry)) || {};
      if (entry) recordValidators.set(entry, cache);
      return getOwnTeam(teamId!, signal, cache);
    },
    staleTime: ROSTER_STALE_TIME_MS,
  });
}

export function useTeams(
  userId?: string,
  poll = false,
  enabled = true,
): { teams: AgentTeam[]; summarized: boolean; isFetching: boolean; isSuccess: boolean; error: string | null; refetch: () => Promise<unknown> } {
  const query = useQuery({
    queryKey: [TEAMS_QUERY_KEY, userId],
    queryFn: ({ signal, client, queryKey }) => {
      const entry = client.getQueryCache().find({ queryKey, exact: true });
      const cache = (entry && rosterValidators.get(entry)) || {};
      if (entry) rosterValidators.set(entry, cache);
      return listTeams(signal, { view: "summary", cache });
    },
    enabled: Boolean(userId) && enabled,
    // Mutations update or invalidate this key; the poll catches changes from
    // other clients and nodes. The stale window lets pages share one read.
    staleTime: ROSTER_STALE_TIME_MS,
    // AuthenticatedApp owns the timer; page observers reuse the same cache.
    refetchInterval: poll ? RELAY_POLL_INTERVALS_MS.teams : false,
  });
  // Getters, not values: React Query re-renders a component for every result
  // field the component READ. Reading isFetching here on behalf of callers
  // that only want the list (App, every board) re-rendered the whole app on
  // each poll's start and end. Only a caller that reads it now pays.
  return {
    teams: query.data?.teams ?? EMPTY_TEAMS,
    get summarized() { return query.data?.view === "summary"; },
    get isSuccess() { return query.isSuccess; },
    get isFetching() { return query.isFetching; },
    get error() { return query.error instanceof Error ? query.error.message : query.error ? String(query.error) : null; },
    refetch: query.refetch,
  };
}
