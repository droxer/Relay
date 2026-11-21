import { useInfiniteQuery, useQuery, type InfiniteData, type Query } from "@tanstack/react-query";
import { useMemo } from "react";
import { getOlderWorkspaceThreads, getWorkspaceActivity } from "../api";
import type { PrivateResponseCache } from "../api-client/client";
import type { WorkspaceActivityResponse, WorkspaceActivityThreads } from "../types";

export const WORKSPACE_ACTIVITY_QUERY_KEY = ["workspace-activity"] as const;

type ActivityThread = WorkspaceActivityThreads["sessions"][number];
type ActivityHead = WorkspaceActivityResponse & { carried?: ActivityThread[] };
const validators = new WeakMap<Query, PrivateResponseCache<WorkspaceActivityResponse>>();

function olderThan(row: ActivityThread, boundary: ActivityThread): boolean {
  const when = Date.parse(row.updatedAt ?? "");
  const cutoff = Date.parse(boundary.updatedAt ?? "");
  return when < cutoff || (when === cutoff && row.id < boundary.id);
}

function activityInterval(data: WorkspaceActivityResponse | undefined): number {
  const live = data?.activeRuns.length
    || data?.tasks.some(task => task.status === "running" || task.status === "queued");
  return live ? 3_000 : 15_000;
}

/** Keep observing active work while the tab is open and reconcile idle work less often. */
export function useWorkspaceActivity(scope: { agentId: string } | { teamId: string }, enabled: boolean) {
  const headKey = [...WORKSPACE_ACTIVITY_QUERY_KEY, scope] as const;
  const historyKey = [...headKey, "older"] as const;
  const head = useQuery({
    queryKey: headKey,
    queryFn: async ({ signal, client }): Promise<ActivityHead> => {
      const query = client.getQueryCache().find({ queryKey: headKey, exact: true });
      const cache = (query && validators.get(query)) ?? {};
      if (query) validators.set(query, cache);
      const checkHistory = !query?.state.isInvalidated;
      const data = await getWorkspaceActivity(scope, signal, cache);
      const boundary = data.sessions.at(-1);
      const history = client.getQueryState(historyKey);
      const previous = client.getQueryData<ActivityHead>(headKey);
      if (!checkHistory || !data.nextThreadCursor || !boundary || !history || !previous
          || (!history.data && history.fetchStatus !== "fetching")) return data;
      // A new Thread can push rows out of the head. Keep those rows above the
      // older pages the reader already loaded, without polling those pages.
      const carried = [...previous.sessions, ...(previous.carried ?? [])]
        .filter(row => olderThan(row, boundary));
      return carried.length ? { ...data, carried } : data;
    },
    enabled,
    staleTime: ({ state }) => activityInterval(state.data),
    refetchInterval: ({ state }) => activityInterval(state.data),
  });
  const older = useInfiniteQuery<
    WorkspaceActivityThreads, Error, InfiniteData<WorkspaceActivityThreads>, typeof historyKey, string | null
  >({
    queryKey: historyKey,
    // An explicit invalidation can refresh loaded history. Routine polling
    // only observes the head, and first opening the tab reads a single page.
    enabled: query => enabled && query.state.data !== undefined,
    staleTime: Infinity,
    initialPageParam: null,
    queryFn: async ({ signal, pageParam, client }): Promise<WorkspaceActivityThreads> => {
      const current = client.getQueryData<ActivityHead>(headKey);
      const cursor = pageParam ?? current?.nextThreadCursor;
      if (!cursor) return { sessions: [], nextThreadCursor: null };
      const page = await getOlderWorkspaceThreads(scope, cursor, signal);
      return pageParam === null ? { ...page, sessions: [...(current?.sessions ?? []), ...page.sessions] } : page;
    },
    getNextPageParam: page => page.nextThreadCursor ?? undefined,
  });
  const data = useMemo(() => {
    const current = head.data;
    const boundary = current?.sessions.at(-1);
    if (!current?.nextThreadCursor || !boundary || !older.data) return current;
    const seen = new Set(current.sessions.map(row => row.id));
    const loaded = [
      ...(current.carried ?? []), ...older.data.pages.flatMap(page => page.sessions),
    ].filter(row => {
      if (seen.has(row.id) || !olderThan(row, boundary)) return false;
      seen.add(row.id);
      return true;
    });
    return { ...current, sessions: [...current.sessions, ...loaded] };
  }, [head.data, older.data]);
  const hasOlder = Boolean(head.data?.nextThreadCursor) && (!older.data || older.hasNextPage);
  return {
    data,
    error: head.error,
    isLoading: head.isLoading,
    refetch: head.refetch,
    hasOlder,
    loadingOlder: older.isFetchingNextPage,
    olderError: older.isFetchNextPageError,
    loadOlder: () => older.fetchNextPage({ cancelRefetch: false }),
  };
}
