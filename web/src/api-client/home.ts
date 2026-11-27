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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isHomeStatsResponse(value: unknown): value is HomeStatsResponse {
  if (!isRecord(value)) return false;
  if (!isRecord(value.tasks) || typeof value.tasks.completed !== "number") return false;
  if (!isRecord(value.conversations) || typeof value.conversations.chats !== "number") return false;
  if (!isRecord(value.runs) || !Array.isArray(value.runs.runtimes)) return false;
  if (!isRecord(value.tokens) || !Array.isArray(value.tokens.daily)) return false;
  return true;
}

export async function getHomeStats(
  period: HomeStatsPeriod = "week",
  signal?: AbortSignal,
  timeZone = viewerTimeZone(),
): Promise<HomeStatsResponse> {
  const query = new URLSearchParams({ period });
  if (timeZone) query.set("tz", timeZone);
  const data = await apiJson<unknown>(`/home/stats?${query.toString()}`, { signal });
  if (!isHomeStatsResponse(data)) {
    throw new Error("Invalid home stats payload");
  }
  return data;
}
