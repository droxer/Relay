import type { DashboardDateRange } from "../lib/dashboardRange";
import { useQuery } from "@tanstack/react-query";
import { getDashboardTokens, type TokenUsageSnapshot } from "../api";

export type { TokenUsageSnapshot };

const KEY = ["admin", "dashboard", "tokens"] as const;
const POLL_INTERVAL_MS = 10_000;

const EMPTY_SNAPSHOT: TokenUsageSnapshot = {
  available: false,
  timeZone: "UTC",
  totalInput: 0,
  totalOutput: 0,
  totalCacheRead: 0,
  totalCacheWrite: 0,
  totalCache: 0,
  total: 0,
  fresh: 0,
  daily: [],
  unreportedRuns: [],
};

export type TokenUsageState = TokenUsageSnapshot & { isError: boolean; error: string | null; isLoading?: boolean };

export function useTokenUsage(range?: DashboardDateRange): TokenUsageState {
  const query = useQuery<TokenUsageSnapshot>({
    queryKey: [...KEY, range?.start, range?.end],
    queryFn: ({ signal }) => getDashboardTokens(signal, undefined, range),
    refetchInterval: POLL_INTERVAL_MS,
  });
  return {
    ...(query.data ?? EMPTY_SNAPSHOT),
    isError: query.isError,
    isLoading: query.isLoading,
    error: query.error instanceof Error ? query.error.message : query.error ? String(query.error) : null,
  };
}
