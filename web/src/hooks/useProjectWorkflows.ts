"use client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { listWorkflows } from "../api";
import { TEAMS_QUERY_KEY } from "./useTeams";

export const WORKFLOWS_QUERY_KEY = "workflows";

export function useProjectWorkflows(projectId?: string, enabled = true) {
  return useQuery({
    queryKey: [WORKFLOWS_QUERY_KEY, projectId ?? "all"],
    queryFn: ({ signal }) => listWorkflows(projectId, signal),
    enabled, staleTime: 15_000, refetchInterval: 30_000,
  });
}

export function useInvalidateWorkflows() {
  const client = useQueryClient();
  return () => Promise.all([
    client.invalidateQueries({ queryKey: [WORKFLOWS_QUERY_KEY] }),
    client.invalidateQueries({ queryKey: [TEAMS_QUERY_KEY] }),
  ]);
}
