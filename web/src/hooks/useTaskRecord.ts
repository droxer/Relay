"use client";

import { useQuery } from "@tanstack/react-query";
import { getTask, RelayApiError } from "../api";
import { RELAY_POLL_INTERVALS_MS } from "../lib/relayPolling";
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
  const query = useQuery({
    queryKey: [TASK_RECORD_QUERY_KEY, taskId],
    queryFn: ({ signal }) => getTask(taskId as string, signal),
    enabled: Boolean(taskId),
    placeholderData: placeholder as RelayTask | undefined,
    refetchInterval: RELAY_POLL_INTERVALS_MS.tasks,
  });

  return {
    task: query.data as RelayTaskListItem | undefined,
    get isPending() { return query.isPending; },
    // A record that 404s is a deleted or mistyped id — the surface says so
    // rather than spinning forever.
    get notFound() { return query.error instanceof RelayApiError && query.error.status === 404; },
    get error() { return query.error instanceof Error ? query.error.message : query.error ? String(query.error) : null; },
  };
}
