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

export type TokenUsageState = TokenUsageSnapshot & { isError: boolean; error: string | null };

export function useTokenUsage(): TokenUsageState {
  const query = useQuery<TokenUsageSnapshot>({
    queryKey: KEY,
    queryFn: ({ signal }) => getDashboardTokens(signal),
    refetchInterval: POLL_INTERVAL_MS,
  });
  return {
    ...(query.data ?? EMPTY_SNAPSHOT),
    isError: query.isError,
    error: query.error instanceof Error ? query.error.message : query.error ? String(query.error) : null,
  };
}
