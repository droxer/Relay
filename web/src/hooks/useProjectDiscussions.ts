import { useInfiniteQuery, type Query } from "@tanstack/react-query";
import { listSessionSummaries, type SessionHeadCache } from "../api";
import { THREAD_PAGE_SIZE } from "../lib/sessionPollMerge";
import { RELAY_POLL_INTERVALS_MS } from "../lib/relayPolling";
import type { ThreadKindFilter } from "../lib/threadKindFilter";

export const PROJECT_DISCUSSIONS_QUERY_KEY = ["project-discussions"] as const;
const headValidators = new WeakMap<Query, SessionHeadCache>();

export function useProjectDiscussions(projectId: string, query: string, kind: ThreadKindFilter) {
  const queryKey = [...PROJECT_DISCUSSIONS_QUERY_KEY, projectId, query, kind] as const;
  return useInfiniteQuery({
    queryKey,
    initialPageParam: "",
    queryFn: ({ client, signal, pageParam }) => {
      const entry = pageParam ? undefined : client.getQueryCache().find({ queryKey, exact: true });
      const cache = entry ? headValidators.get(entry) ?? {} : undefined;
      if (entry && cache) headValidators.set(entry, cache);
      return listSessionSummaries(signal, {
        projectId, query, kind, limit: THREAD_PAGE_SIZE, includeActivity: true, cursor: pageParam || undefined,
      }, cache);
    },
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    staleTime: RELAY_POLL_INTERVALS_MS.projectDiscussionsIdle,
    refetchInterval: ({ state }) => {
      const active = state.data?.pages.some(page => page.sessions.some(({ execution }) =>
        execution && execution.phase !== "terminal" && execution.phase !== "recovery_required"));
      return active ? RELAY_POLL_INTERVALS_MS.projectDiscussionsActive : RELAY_POLL_INTERVALS_MS.projectDiscussionsIdle;
    },
  });
}
