import { useQuery } from "@tanstack/react-query";
import { getDashboardSessions, type DashboardSessionsResponse } from "../api";

const KEY = ["admin", "dashboard", "sessions"] as const;
const POLL_INTERVAL_MS = 10_000;

const EMPTY: DashboardSessionsResponse = {
  total: 0,
  last24h: 0,
  last7d: 0,
  statusCounts: {},
  dailyCounts: [],
  topEmployees: [],
};

export function useDashboardSessions(enabled: boolean): {
  data: DashboardSessionsResponse;
  isLoading: boolean;
  isError: boolean;
  error: string | null;
} {
  const query = useQuery<DashboardSessionsResponse>({
    queryKey: KEY,
    queryFn: ({ signal }) => getDashboardSessions(signal),
    enabled,
    refetchInterval: POLL_INTERVAL_MS,
  });
  return {
    data: query.data ?? EMPTY,
    isLoading: query.isLoading,
    isError: query.isError,
    error: query.error instanceof Error ? query.error.message : query.error ? String(query.error) : null,
  };
}
