import { useQuery } from "@tanstack/react-query";
import { getWorkspaceActivity } from "../api";
import type { WorkspaceActivityResponse } from "../types";

export const WORKSPACE_ACTIVITY_QUERY_KEY = ["workspace-activity"] as const;

function activityInterval(data: WorkspaceActivityResponse | undefined): number {
  const live = data?.activeRuns.length
    || data?.tasks.some(task => task.status === "running" || task.status === "queued");
  return live ? 3_000 : 15_000;
}

/** Keep observing active work while the tab is open and reconcile idle work less often. */
export function useWorkspaceActivity(scope: { agentId: string } | { teamId: string }, enabled: boolean) {
  return useQuery({
    queryKey: [...WORKSPACE_ACTIVITY_QUERY_KEY, scope],
    queryFn: ({ signal }) => getWorkspaceActivity(scope, signal),
    enabled,
    staleTime: ({ state }) => activityInterval(state.data),
    refetchInterval: ({ state }) => activityInterval(state.data),
  });
}
