import { useEffect, useMemo } from "react";
import { queryOptions, useInfiniteQuery, useMutation, useQuery, useQueryClient, type InfiniteData, type Query, type QueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { listSessionSummaries, setDiscussionPin, type SessionHeadCache } from "../api";
import { THREAD_PAGE_SIZE } from "../lib/sessionPollMerge";
import { RELAY_POLL_INTERVALS_MS } from "../lib/relayPolling";
import type { RelaySession, SessionSummariesResponse, SessionSummary } from "../types";
import { useMutationError } from "./useMutationError";

export const PROJECT_DISCUSSIONS_QUERY_KEY = ["project-discussions"] as const;
const headValidators = new WeakMap<Query, SessionHeadCache>();

type DiscussionHead = { page: SessionSummariesResponse; displaced: SessionSummary[] };

function discussionPage(projectId: string, query: string) {
  return { projectId, query, kind: "chats", limit: THREAD_PAGE_SIZE, includeActivity: true } as const;
}

function projectDiscussionsOptions(projectId: string, query: string) {
  const queryKey = [...PROJECT_DISCUSSIONS_QUERY_KEY, projectId, query] as const;
  return queryOptions({
    queryKey,
    staleTime: RELAY_POLL_INTERVALS_MS.projectDiscussionsIdle,
    queryFn: async ({ client, signal }): Promise<DiscussionHead> => {
      const entry = client.getQueryCache().find({ queryKey, exact: true });
      const cache = entry ? headValidators.get(entry) ?? {} : undefined;
      if (entry && cache) headValidators.set(entry, cache);
      const page = await listSessionSummaries(signal, discussionPage(projectId, query), cache);
      const historyKey = [...queryKey, "history"] as const;
      const history = client.getQueryState(historyKey);
      const previous = client.getQueryData<DiscussionHead>(queryKey);
      if (!page.nextCursor) {
        if (history && (history.status !== "pending" || history.fetchStatus !== "idle")) {
          void client.resetQueries({ queryKey: historyKey, exact: true });
        }
        return { page, displaced: [] };
      }
      if (!previous || !history || (!history.data && history.fetchStatus === "idle")) {
        return { page, displaced: [] };
      }
      if (previous.page === page) return previous;

      // Keep the continuous loaded range when a refreshed head pushes rows
      // across the existing history cursor. Rows still inside the new head's
      // range but absent from it are no longer in the results.
      const boundary = page.sessions.at(-1);
      if (!boundary) return { page, displaced: [] };
      const boundaryTime = Date.parse(boundary.updatedAt);
      const ids = new Set(page.sessions.map(row => row.id));
      const displaced = [...previous.page.sessions, ...previous.displaced].filter(row => {
        if (ids.has(row.id)) return false;
        if (Boolean(row.discussionPinned) !== Boolean(boundary.discussionPinned)) return !row.discussionPinned;
        const time = Date.parse(row.updatedAt);
        return time < boundaryTime || (time === boundaryTime && row.id < boundary.id);
      });
      return { page, displaced };
    },
  });
}

export function usePrefetchProjectDiscussions(projectId: string | null | undefined, query: string) {
  const client = useQueryClient();
  useEffect(() => {
    if (projectId) void client.prefetchQuery(projectDiscussionsOptions(projectId, query));
  }, [client, projectId, query]);
}

export function useProjectDiscussions(projectId: string, query: string) {
  const options = projectDiscussionsOptions(projectId, query);
  const head = useQuery({
    ...options,
    refetchInterval: ({ state }) => {
      const active = state.data?.page.sessions.some(({ execution }) =>
        execution && execution.phase !== "terminal" && execution.phase !== "recovery_required");
      return active ? RELAY_POLL_INTERVALS_MS.projectDiscussionsActive : RELAY_POLL_INTERVALS_MS.projectDiscussionsIdle;
    },
  });
  const firstCursor = head.data?.page.nextCursor ?? null;
  const history = useInfiniteQuery({
    queryKey: [...options.queryKey, "history"],
    enabled: false,
    initialPageParam: firstCursor,
    queryFn: ({ signal, pageParam }) => listSessionSummaries(signal, {
      ...discussionPage(projectId, query), cursor: pageParam ?? undefined,
    }),
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });
  const sessions = useMemo(() => {
    const seen = new Set<string>();
    return [
      ...(head.data?.page.sessions ?? []),
      ...(head.data?.displaced ?? []),
      ...(firstCursor ? history.data?.pages.flatMap(page => page.sessions) ?? [] : []),
    ].filter(row => {
      if (row.taskActivity?.origin || seen.has(row.id)) return false;
      seen.add(row.id);
      return true;
    });
  }, [firstCursor, head.data, history.data]);

  return {
    loaded: head.data !== undefined,
    sessions,
    isPending: head.isPending,
    refetch: head.refetch,
    hasNextPage: Boolean(firstCursor && (!history.data || history.hasNextPage)),
    isFetchingNextPage: history.isFetchingNextPage,
    isFetchNextPageError: history.isFetchNextPageError,
    fetchNextPage: history.fetchNextPage,
  };
}

export function removeCachedProjectDiscussion(client: QueryClient, threadId: string, projectId?: string) {
  const scope = projectId ? [...PROJECT_DISCUSSIONS_QUERY_KEY, projectId] : PROJECT_DISCUSSIONS_QUERY_KEY;
  updateCachedDiscussions(client, scope, rows => rows.filter(row => row.id !== threadId));
}

export function applyProjectDiscussionDeletions(
  client: QueryClient, results: ReadonlyMap<string, RelaySession["execution"]>,
) {
  const requestedAt = new Date().toISOString();
  updateCachedDiscussions(client, PROJECT_DISCUSSIONS_QUERY_KEY, rows => rows.flatMap(row => {
    if (!results.has(row.id)) return [row];
    const execution = results.get(row.id);
    return execution ? [{ ...row, execution, deletionRequestedAt: row.deletionRequestedAt ?? requestedAt }] : [];
  }));
}

function updateCachedDiscussions(
  client: QueryClient, scope: readonly string[], update: (rows: SessionSummary[]) => SessionSummary[],
) {
  for (const entry of client.getQueryCache().findAll({ queryKey: scope })) {
    const key = entry.queryKey;
    if (key[3] === "history") {
      // A page started before the mutation may still contain this row.
      if (entry.state.fetchStatus !== "idle") void client.cancelQueries({ queryKey: key, exact: true });
      client.setQueryData<InfiniteData<SessionSummariesResponse>>(key, current => current && ({
        ...current,
        pages: current.pages.map(page => ({ ...page, sessions: update(page.sessions) })),
      }));
    } else {
      headValidators.delete(entry);
      client.setQueryData<DiscussionHead>(key, current => current && ({
        page: { ...current.page, sessions: update(current.page.sessions) },
        displaced: update(current.displaced),
      }));
    }
  }
}

export function useProjectDiscussionPin(projectId: string) {
  const client = useQueryClient();
  const { t } = useTranslation();
  const { reportMutationError } = useMutationError();
  const scope = [...PROJECT_DISCUSSIONS_QUERY_KEY, projectId] as const;
  return useMutation({
    mutationFn: ({ id, pinned }: { id: string; pinned: boolean }) => setDiscussionPin(id, pinned),
    onSuccess: async () => {
      // A pin can move across pages. Old history cursors can skip the row in
      // its new position, so subsequent pages must start at the new head.
      await client.cancelQueries({ queryKey: scope });
      await client.resetQueries({ queryKey: scope, predicate: entry => entry.queryKey[3] === "history" });
      await client.invalidateQueries({ queryKey: scope });
    },
    onError: (error, { pinned }) => reportMutationError(
      "Failed to update discussion pin", error, t(pinned ? "project.discussions_pin_failed" : "project.discussions_unpin_failed"),
    ),
  });
}
