"use client";

import { useQuery } from "@tanstack/react-query";
import { RELAY_POLL_INTERVALS_MS, ROSTER_STALE_TIME_MS } from "../lib/relayPolling";
import { listTeams } from "../api";
import type { AgentTeam } from "../types";

export const TEAMS_QUERY_KEY = "teams";
const EMPTY_TEAMS: AgentTeam[] = [];

export function useTeams(
  userId?: string,
): { teams: AgentTeam[]; isFetching: boolean; error: string | null; refetch: () => Promise<unknown> } {
  const query = useQuery({
    queryKey: [TEAMS_QUERY_KEY, userId],
    queryFn: ({ signal }) => listTeams(signal),
    enabled: Boolean(userId),
    // Every roster mutation invalidates this key, so the poll only has to
    // catch node-reported availability drift; the stale window lets the many
    // pages that mount this hook share one read instead of refetching.
    staleTime: ROSTER_STALE_TIME_MS,
    refetchInterval: RELAY_POLL_INTERVALS_MS.teams,
  });
  // Getters, not values: React Query re-renders a component for every result
  // field the component READ. Reading isFetching here on behalf of callers
  // that only want the list (App, every board) re-rendered the whole app on
  // each poll's start and end. Only a caller that reads it now pays.
  return {
    teams: query.data?.teams ?? EMPTY_TEAMS,
    get isFetching() { return query.isFetching; },
    get error() { return query.error instanceof Error ? query.error.message : query.error ? String(query.error) : null; },
    refetch: query.refetch,
  };
}
