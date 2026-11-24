import type { DashboardRange } from "../lib/dashboardRange";
import { useQuery } from "@tanstack/react-query";
import { getDashboardWork, type DashboardWorkResponse } from "../api";
import { RELAY_POLL_INTERVALS_MS } from "../lib/relayPolling";

const KEY = ["admin", "dashboard", "work"] as const;

const EMPTY: DashboardWorkResponse = {
  projects: {
    total: 0,
    enabled: 0,
    disabled: 0,
    archived: 0,
    created: 0,
    activeInRange: 0,
  },
  tasks: {
    total: 0,
    open: 0,
    created: 0,
    done: 0,
    inProgress: 0,
    blocked: 0,
    backlog: 0,
    cancelled: 0,
    inProjects: 0,
    standalone: 0,
    statusCounts: {},
  },
  conversations: {
    total: 0,
    chats: 0,
    totalChats: 0,
    projectChats: 0,
    standaloneChats: 0,
    taskRuns: 0,
    automationRuns: 0,
  },
};

export function useDashboardWork(enabled: boolean, range?: DashboardRange): {
  data: DashboardWorkResponse;
  isLoading: boolean;
  isError: boolean;
  error: string | null;
} {
  const query = useQuery<DashboardWorkResponse>({
    queryKey: [...KEY, range ?? null],
    queryFn: ({ signal }) => getDashboardWork(signal, range),
    enabled,
    staleTime: RELAY_POLL_INTERVALS_MS.dashboardMetrics,
    refetchInterval: RELAY_POLL_INTERVALS_MS.dashboardMetrics,
  });
  return {
    data: query.data ?? EMPTY,
    isLoading: query.isLoading,
    isError: query.isError,
    error: query.error instanceof Error ? query.error.message : query.error ? String(query.error) : null,
  };
}
