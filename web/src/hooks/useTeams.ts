"use client";

import { useQuery } from "@tanstack/react-query";
import { listTeams } from "../api";
import type { AgentTeam } from "../types";

export const TEAMS_QUERY_KEY = "teams";
const EMPTY_TEAMS: AgentTeam[] = [];

export function useTeams(
  employeeId?: string,
): { teams: AgentTeam[]; isFetching: boolean; error: string | null; refetch: () => Promise<unknown> } {
  const query = useQuery({
    queryKey: [TEAMS_QUERY_KEY, employeeId],
    queryFn: ({ signal }) => listTeams(signal),
    enabled: Boolean(employeeId),
    refetchInterval: 10_000,
  });
  // Getters, not values: React Query re-renders a component for every result
  // field the component READ. Reading isFetching here on behalf of callers
  // that only want the list (App, every board) re-rendered the whole app on
  // each 10s poll's start and end. Only a caller that reads it now pays.
  return {
    teams: query.data?.teams ?? EMPTY_TEAMS,
    get isFetching() { return query.isFetching; },
    get error() { return query.error instanceof Error ? query.error.message : query.error ? String(query.error) : null; },
    refetch: query.refetch,
  };
}
