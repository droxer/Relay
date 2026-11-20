"use client";

import { useQuery } from "@tanstack/react-query";
import { getTask, RelayApiError } from "../api";
import { useTaskQueryRevision } from "./useTaskQueryRevision";
import { taskRecordPollIntervalMs } from "../lib/relayPolling";
import type { RelayTaskListItem } from "../types";

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
 * When the list already polls this Task, its revision is the change signal
 * for the record. A record outside the list owns its polling, with a slower
 * cadence once it settles.
 */
export function useTaskRecord(
  taskId: string | null,
  placeholder?: RelayTaskListItem,
  dependentIds?: readonly string[],
): {
  task: RelayTaskListItem | undefined;
  isPending: boolean;
  notFound: boolean;
  error: string | null;
} {
  const query = useQuery({
    queryKey: [TASK_RECORD_QUERY_KEY, taskId],
    queryFn: ({ signal }) => getTask(taskId as string, signal, "record"),
    enabled: Boolean(taskId),
    placeholderData: placeholder,
    refetchInterval: (current) => taskRecordPollIntervalMs(current.state.data?.status, placeholder !== undefined),
  });

  const eventCount = placeholder && "eventCount" in placeholder && typeof placeholder.eventCount === "number"
    ? placeholder.eventCount
    : undefined;
  const listStamp = placeholder
    ? JSON.stringify([placeholder.status, placeholder.updatedAt, eventCount, placeholder.waitingOn ?? [], dependentIds ?? []])
    : undefined;
  useTaskQueryRevision(TASK_RECORD_QUERY_KEY, taskId, listStamp, query.isFetching);

  return {
    task: query.data,
    get isPending() { return query.isPending; },
    // A record that 404s is a deleted or mistyped id — the surface says so
    // rather than spinning forever.
    get notFound() { return query.error instanceof RelayApiError && query.error.status === 404; },
    get error() { return query.error instanceof Error ? query.error.message : query.error ? String(query.error) : null; },
  };
}
