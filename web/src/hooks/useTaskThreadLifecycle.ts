import { useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { listTaskEvents } from "../api";
import { pathForAppState } from "../lib/appRoute";
import { RELAY_POLL_INTERVALS_MS } from "../lib/relayPolling";
import { taskRef } from "../lib/taskRef";
import {
  placeLifecycleMarkers,
  threadLifecycleMarkers,
  type LifecycleMarker,
  type PlacedLifecycle,
} from "../lib/taskThreadLifecycle";
import { threadOriginIndex } from "../lib/threads";
import type { ThreadTaskFact } from "../components/ThreadMeta";
import type { RelaySession, RelayTaskListItem } from "../types";

export type OpenTaskRecord = (target: { taskId: string; routineId?: string }) => void;

export type ThreadTaskLifecycle = PlacedLifecycle & {
  /** The header's task chip; undefined for a thread no task owns. */
  task?: ThreadTaskFact;
  /** The marker the task still sits on — it alone carries a next step. */
  currentMarkerId?: string;
};

const NONE: ThreadTaskLifecycle = { before: new Map(), trailing: [] };

function taskHref(task: RelayTaskListItem): string {
  return task.sourceRoutineId
    ? pathForAppState({ route: "routine", mobileView: "chat", sessionId: null, taskId: task.sourceRoutineId, runId: task.id })
    : pathForAppState({ route: "backlog", mobileView: "chat", sessionId: null, taskId: task.id });
}

/**
 * The task a thread works on, and every status change it went through here.
 *
 * Reads the task's event log under the record timeline's cache key, so opening
 * the task after its thread (or the reverse) costs no second request. It does
 * not poll: the task list already polls, and a change in the task's status —
 * the only thing these markers show — is what refetches the log.
 */
export function useTaskThreadLifecycle({ tasks, session, messages, currentUserId, onOpenTaskRecord }: {
  tasks: readonly RelayTaskListItem[];
  session: Pick<RelaySession, "id" | "createdAt"> | undefined;
  /** The transcript, oldest first — the markers are slotted between turns. */
  messages: readonly { id: string; timestamp: string }[];
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
    queryFn: ({ signal }) => listTaskEvents(taskId as string, {}, signal),
    enabled: Boolean(taskId),
    staleTime: RELAY_POLL_INTERVALS_MS.tasks,
  });
  const { refetch } = eventsQuery;
  useEffect(() => {
    if (taskId && status) void refetch();
  }, [refetch, taskId, status]);
  const events = eventsQuery.data?.events;

  const markers = useMemo<LifecycleMarker[]>(
    () => events && sessionId && sessionCreatedAt
      ? threadLifecycleMarkers(events, { sessionId, sessionCreatedAt, currentUserId })
      : [],
    [events, sessionId, sessionCreatedAt, currentUserId],
  );

  return useMemo(() => {
    if (!task) return NONE;
    const last = markers.at(-1);
    const fact: ThreadTaskFact = {
      ref: taskRef(task),
      status: task.status,
      href: taskHref(task),
      onOpen: () => onOpenTaskRecord?.(
        task.sourceRoutineId ? { taskId: task.id, routineId: task.sourceRoutineId } : { taskId: task.id },
      ),
    };
    return {
      ...placeLifecycleMarkers(messages, markers),
      task: fact,
      ...(last && last.to === task.status ? { currentMarkerId: last.id } : {}),
    };
  }, [markers, messages, onOpenTaskRecord, task]);
}
