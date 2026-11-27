import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { getHomeStats, type HomeStatsPeriod, type HomeStatsResponse } from "../api-client/home";
import { RELAY_POLL_INTERVALS_MS } from "../lib/relayPolling";

export const HOME_STATS_QUERY_KEY = ["home", "stats"] as const;

export interface UseHomeStatsResult {
  data: HomeStatsResponse | undefined;
  isLoading: boolean;
  isFetching: boolean;
  isError: boolean;
  refetch: () => Promise<unknown>;
}

export function useHomeStats(period: HomeStatsPeriod, enabled = true): UseHomeStatsResult {
  const query = useQuery<HomeStatsResponse>({
    queryKey: [...HOME_STATS_QUERY_KEY, period],
    queryFn: ({ signal }) => getHomeStats(period, signal),
    enabled,
    placeholderData: keepPreviousData,
    staleTime: RELAY_POLL_INTERVALS_MS.dashboardMetrics,
    refetchInterval: RELAY_POLL_INTERVALS_MS.dashboardMetrics,
  });
  return {
    data: query.data,
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    isError: query.isError,
    refetch: query.refetch,
  };
}
