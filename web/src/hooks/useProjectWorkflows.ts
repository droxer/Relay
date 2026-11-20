"use client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getWorkflow, listWorkflows, RelayApiError } from "../api";
import type { Workflow } from "../types";
import { TEAMS_QUERY_KEY } from "./useTeams";

export const WORKFLOWS_QUERY_KEY = "workflows";
const WORKFLOW_STALE_MS = 15_000;
const WORKFLOW_REFRESH_MS = 30_000;

export function useProjectWorkflows(projectId?: string, enabled = true) {
  return useQuery({
    queryKey: [WORKFLOWS_QUERY_KEY, projectId ?? "all"],
    queryFn: ({ signal }) => listWorkflows(projectId, signal),
    enabled, staleTime: WORKFLOW_STALE_MS, refetchInterval: WORKFLOW_REFRESH_MS,
  });
}

export function useWorkflowName(workflowId?: string | null, projectId?: string | null) {
  const client = useQueryClient();
  return useQuery({
    queryKey: [WORKFLOWS_QUERY_KEY, "name", workflowId],
    enabled: Boolean(workflowId),
    staleTime: WORKFLOW_STALE_MS,
    refetchInterval: WORKFLOW_REFRESH_MS,
    queryFn: async ({ signal }) => {
      if (!workflowId) return null;
      for (const scope of projectId ? [projectId, "all"] : ["all"]) {
        const catalog = client.getQueryState<{ workflows: Workflow[] }>([WORKFLOWS_QUERY_KEY, scope]);
        if (!catalog?.data || catalog.isInvalidated || Date.now() - catalog.dataUpdatedAt >= WORKFLOW_STALE_MS) continue;
        const cached = catalog.data.workflows.find(workflow => workflow.id === workflowId);
        if (cached) return cached.name;
      }
      try {
        return (await getWorkflow(workflowId, signal)).workflow.name;
      } catch (error) {
        if (error instanceof RelayApiError && (error.status === 404 || error.status === 403)) return null;
        throw error;
      }
    },
  });
}

export function useInvalidateWorkflows() {
  const client = useQueryClient();
  return () => Promise.all([
    client.invalidateQueries({ queryKey: [WORKFLOWS_QUERY_KEY] }),
    client.invalidateQueries({ queryKey: [TEAMS_QUERY_KEY] }),
  ]);
}
