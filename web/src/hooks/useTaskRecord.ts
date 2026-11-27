"use client";

import { useCallback, useSyncExternalStore } from "react";
import { queryOptions, useQuery, useQueryClient, type Query } from "@tanstack/react-query";
import { getTask, RelayApiError } from "../api";
import type { PrivateResponseCache } from "../api-client/client";
import { useTaskQueryRevision } from "./useTaskQueryRevision";
import { taskRecordPollIntervalMs } from "../lib/relayPolling";
import type { RoutineListState } from "../lib/routine";
import { SESSIONS_QUERY_KEY } from "../lib/sessionPollMerge";
import { canCancelThreadRun } from "../lib/threadRunning";
import type { RelaySession, RelayTaskListItem } from "../types";

export const TASK_RECORD_QUERY_KEY = "task-record";
const validators = new WeakMap<Query, PrivateResponseCache<RelayTaskListItem>>();

export function taskRecordQueryOptions(taskId: string | null) {
  return queryOptions({
    queryKey: [TASK_RECORD_QUERY_KEY, taskId] as const,
    queryFn: ({ signal, queryKey, client }) => {
      const entry = client.getQueryCache().find({ queryKey, exact: true });
      const cache = (entry && validators.get(entry)) || {};
      if (entry) validators.set(entry, cache);
      return getTask(taskId as string, signal, "record", cache);
    },
  });
}

function taskListRevision(task: RelayTaskListItem, eventCount: number | undefined, dependents: readonly string[]) {
  return JSON.stringify([task.status, task.updatedAt, eventCount, task.waitingOn ?? [], dependents]);
}

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
  compactList = false,
  automationState?: RoutineListState,
): {
  task: RelayTaskListItem | undefined;
  isPending: boolean;
  notFound: boolean;
  error: string | null;
} {
  const query = useQuery({
    ...taskRecordQueryOptions(taskId),
    enabled: Boolean(taskId),
    placeholderData: compactList ? undefined : placeholder,
    refetchInterval: (current) => taskRecordPollIntervalMs(current.state.data?.status,
      placeholder !== undefined && (!compactList || placeholder.isRoutine)),
  });

  const eventCount = placeholder && "eventCount" in placeholder && typeof placeholder.eventCount === "number"
    ? placeholder.eventCount
    : undefined;
  const taskStamp = placeholder ? taskListRevision(placeholder, eventCount, dependentIds ?? []) : undefined;
  const listStamp = placeholder?.isRoutine
    ? JSON.stringify([taskStamp, automationState, placeholder.hasCompletedOccurrence]) : taskStamp;
  const record = query.isPlaceholderData ? undefined : query.data;
  // Prerequisites and dependents can change without a new event on this Task.
  const matchesRevision = Boolean(placeholder && record && record.updatedAt === placeholder.updatedAt
    && eventCount !== undefined && "eventCount" in record && record.eventCount === eventCount
    && (placeholder.isRoutine ? (
      (automationState === undefined || (
        (automationState === "running") === Boolean(record.hasRunningOccurrence)
        && (automationState === "running" || (automationState === "completed") === Boolean(record.hasCompletedOccurrence))
      ))
      && (placeholder.hasCompletedOccurrence === undefined
        || placeholder.hasCompletedOccurrence === Boolean(record.hasCompletedOccurrence))
    ) : (record.waitingOn && record.unblocks
      && taskListRevision(record, eventCount, [...record.unblocks].sort()) === listStamp)));
  useTaskQueryRevision(TASK_RECORD_QUERY_KEY, taskId, listStamp, query.isFetching, matchesRevision);

  return {
    task: query.data,
    get isPending() { return query.isPending; },
    // A record that 404s is a deleted or mistyped id — the surface says so
    // rather than spinning forever.
    get notFound() { return query.error instanceof RelayApiError && query.error.status === 404; },
    get error() { return query.error instanceof Error ? query.error.message : query.error ? String(query.error) : null; },
  };
}

/** The record can stop admitted work even before the daemon changes the Task
 * from assigned to running. Reuse the shell's Thread projection. */
export function useTaskExecutionThread(task: RelayTaskListItem | undefined): string | undefined {
  const client = useQueryClient();
  const subscribe = useCallback((listener: () => void) => client.getQueryCache().subscribe(({ query, type }) => {
    if ((type === "updated" || type === "removed") && query.queryKey.length === SESSIONS_QUERY_KEY.length
      && SESSIONS_QUERY_KEY.every((part, i) => query.queryKey[i] === part)) listener();
  }), [client]);
  const snapshot = () => {
    if (!task || task.isRoutine || !["running", "assigned", "queued"].includes(task.status)) return undefined;
    const sessions = client.getQueryData<RelaySession[]>(SESSIONS_QUERY_KEY);
    const threadId = task.linkedSessionIds?.at(-1);
    const session = sessions?.find(row => row.id === threadId);
    if (!session) return task.status === "running" ? threadId : undefined;
    const scope = session.collaborationRounds?.find(round => round.roundId === session.activeRoundId)?.workScope;
    if (scope && (scope.kind !== "task" || scope.taskId !== task.id)) return undefined;
    return canCancelThreadRun({ session, activeRun: undefined }) ? session.id : undefined;
  };
  return useSyncExternalStore(subscribe, snapshot, () => undefined);
}
