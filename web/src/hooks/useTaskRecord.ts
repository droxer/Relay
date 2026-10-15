"use client";

import { useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getTask, RelayApiError } from "../api";
import { taskRecordPollIntervalMs } from "../lib/relayPolling";
import type { RelayTask, RelayTaskListItem } from "../types";

export const TASK_RECORD_QUERY_KEY = "task-record";

/**
 * One task or routine, for its record surface.
 *
 * The polled task list usually holds the record already, and the tempting
 * shortcut is to seed the cache with it. Don't: `setQueryData` and
 * `initialData` both make the query report as already fetched, so
 * `isPending`/`isFetchedAfterMount` go permanently false and every loading
 * state built on them is dead. `placeholderData` paints immediately and
 * leaves those flags honest.
 *
 * The record polls only until it settles (done or blocked). After that the
 * list row — itself polled, and written by every task mutation — is the
 * change signal: when its status or updatedAt moves, the record refetches,
 * so a retry, a reopen, or another person's edit still reaches the surface.
 * A record with no list row (opened by deep link past the list's page) keeps
 * a slow poll instead, since nothing else would tell it to refetch.
 */
export function useTaskRecord(
  taskId: string | null,
  placeholder?: RelayTaskListItem,
): {
  task: RelayTaskListItem | undefined;
  isPending: boolean;
  notFound: boolean;
  error: string | null;
} {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: [TASK_RECORD_QUERY_KEY, taskId],
    queryFn: ({ signal }) => getTask(taskId as string, signal),
    enabled: Boolean(taskId),
    placeholderData: placeholder as RelayTask | undefined,
    refetchInterval: (current) => taskRecordPollIntervalMs(current.state.data?.status, placeholder !== undefined),
  });

  const listStamp = placeholder ? `${placeholder.status}|${placeholder.updatedAt}` : undefined;
  const seenStamp = useRef({ taskId, listStamp });
  useEffect(() => {
    const previous = seenStamp.current;
    seenStamp.current = { taskId, listStamp };
    // Mounting (or switching records) already fetches, and a list row that
    // only just arrived says nothing new; only a change to it is news.
    if (!taskId || previous.taskId !== taskId || !previous.listStamp || !listStamp) return;
    if (previous.listStamp === listStamp) return;
    void queryClient.invalidateQueries(
      { queryKey: [TASK_RECORD_QUERY_KEY, taskId], exact: true },
      { cancelRefetch: false },
    );
  }, [listStamp, queryClient, taskId]);

  return {
    task: query.data as RelayTaskListItem | undefined,
    get isPending() { return query.isPending; },
    // A record that 404s is a deleted or mistyped id — the surface says so
    // rather than spinning forever.
    get notFound() { return query.error instanceof RelayApiError && query.error.status === 404; },
    get error() { return query.error instanceof Error ? query.error.message : query.error ? String(query.error) : null; },
  };
}
