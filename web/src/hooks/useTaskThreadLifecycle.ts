import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { listTaskEvents } from "../api";
import { pathForAppState } from "../lib/appRoute";
import { useTaskQueryRevision } from "./useTaskQueryRevision";
import { RELAY_POLL_INTERVALS_MS } from "../lib/relayPolling";
import { taskRef } from "../lib/taskRef";
import { threadLifecycleMarkers, type LifecycleMarker } from "../lib/taskThreadLifecycle";
import { threadOriginIndex } from "../lib/threads";
import type { ThreadTaskFact } from "../components/ThreadMeta";
import type { RelaySession, RelayTaskListItem } from "../types";

export type OpenTaskRecord = (target: { taskId: string; routineId?: string }) => void;

export type ThreadTaskLifecycle = {
  /** The header's task chip; undefined for a thread no task owns. */
  task?: ThreadTaskFact;
  /** The task's status changes in this thread, oldest first. */
  markers: LifecycleMarker[];
};

const NONE: ThreadTaskLifecycle = { markers: [] };

function taskHref(task: RelayTaskListItem): string {
  return task.sourceRoutineId
    ? pathForAppState({ route: "routine", mobileView: "chat", sessionId: null, taskId: task.sourceRoutineId, runId: task.id })
    : pathForAppState({ route: "backlog", mobileView: "chat", sessionId: null, taskId: task.id });
}

/**
 * The task a thread works on, and every status change it went through here.
 *
 * Cache the lifecycle events per Task so its Threads share the same history.
 * The Task list's revision triggers revalidation when the underlying Task changes.
 */
export function useTaskThreadLifecycle({ tasks, session, currentUserId, onOpenTaskRecord }: {
  tasks: readonly RelayTaskListItem[];
  session: Pick<RelaySession, "id" | "createdAt"> | undefined;
  currentUserId: string | undefined;
  onOpenTaskRecord?: OpenTaskRecord;
}): ThreadTaskLifecycle {
  const sessionId = session?.id;
  const sessionCreatedAt = session?.createdAt;
  const task = useMemo(() => {
    if (!sessionId) return undefined;
    const origin = threadOriginIndex(tasks).get(sessionId);
    return origin ? tasks.find((item) => item.id === origin.taskId) : undefined;
  }, [sessionId, tasks]);
  const taskId = task?.id;
  const status = task?.status;

  const eventsQuery = useQuery({
    queryKey: ["task-events", taskId],
    queryFn: ({ signal }) => listTaskEvents(taskId as string, { view: "lifecycle" }, signal),
    enabled: Boolean(taskId),
    staleTime: RELAY_POLL_INTERVALS_MS.tasks,
  });
  useTaskQueryRevision("task-events", taskId ?? null, task?.updatedAt ?? status, eventsQuery.isFetching);
  const events = eventsQuery.data?.events;

  const markers = useMemo<LifecycleMarker[]>(
    () => events && sessionId && sessionCreatedAt
      ? threadLifecycleMarkers(events, { sessionId, sessionCreatedAt, currentUserId })
      : [],
    [events, sessionId, sessionCreatedAt, currentUserId],
  );

  return useMemo(() => {
    if (!task) return NONE;
    const fact: ThreadTaskFact = {
      id: task.id,
      current: task.linkedSessionIds.at(-1) === sessionId,
      ref: taskRef(task),
      status: task.status,
      ...(task.status === "blocked" && task.blockerReason ? { blockerReason: task.blockerReason } : {}),
      href: taskHref(task),
      onOpen: () => onOpenTaskRecord?.(
        task.sourceRoutineId ? { taskId: task.id, routineId: task.sourceRoutineId } : { taskId: task.id },
      ),
    };
    return {
      markers,
      task: fact,
    };
  }, [markers, onOpenTaskRecord, sessionId, task]);
}
