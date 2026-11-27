import type { DashboardBucketSize } from "../lib/dashboardRange.ts";
import type { RuntimeUsageRow, TokenCounts } from "./admin.ts";
import { apiJson } from "./client.ts";

export type HomeStatsPeriod = "week" | "30d" | "all";

export interface HomeTaskStats {
  completed: number;
  created: number;
  open: number;
  inProgress: number;
}

export interface HomeConversationStats {
  total: number;
  chats: number;
  projectChats: number;
  standaloneChats: number;
  taskRuns: number;
  automationRuns: number;
}

export interface HomeRunStats {
  total: number;
  reported: number;
  unreported: number;
  runtimes: RuntimeUsageRow[];
}

export interface HomeTokenStats {
  available: boolean;
  bucketSize: DashboardBucketSize;
  fresh: number;
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
  cache: number;
  total: number;
  daily: Array<TokenCounts & { date: string }>;
  unreportedRuns: Array<{ agent: string; runs: number }>;
}

export interface HomeStatsResponse {
  period: HomeStatsPeriod;
  startDate: string | null;
  endDate: string | null;
  timeZone: string;
  tasks: HomeTaskStats;
  conversations: HomeConversationStats;
  runs: HomeRunStats;
  tokens: HomeTokenStats;
}

function viewerTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

export function getHomeStats(
  period: HomeStatsPeriod = "week",
  signal?: AbortSignal,
  timeZone = viewerTimeZone(),
): Promise<HomeStatsResponse> {
  const query = new URLSearchParams({ period });
  if (timeZone) query.set("tz", timeZone);
  return apiJson<HomeStatsResponse>(`/home/stats?${query.toString()}`, { signal });
}
