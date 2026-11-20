import type { DashboardRange } from "../lib/dashboardRange";
import { useQuery } from "@tanstack/react-query";
import { getDashboardSessions, type DashboardSessionsResponse } from "../api";
import { RELAY_POLL_INTERVALS_MS } from "../lib/relayPolling";

const KEY = ["admin", "dashboard", "sessions"] as const;

const EMPTY: DashboardSessionsResponse = {
  total: 0,
  last24h: 0,
  last7d: 0,
  statusCounts: {},
  dailyCounts: [],
  topUsers: [],
};

export function useDashboardSessions(enabled: boolean, range?: DashboardRange): {
  data: DashboardSessionsResponse;
  isLoading: boolean;
  isError: boolean;
  error: string | null;
} {
  const query = useQuery<DashboardSessionsResponse>({
    queryKey: [...KEY, range ?? null],
    queryFn: ({ signal }) => getDashboardSessions(signal, range),
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
