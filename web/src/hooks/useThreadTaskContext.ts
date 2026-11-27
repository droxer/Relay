"use client";

import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { observedSessionEventCount } from "../lib/sessionPollMerge";
import type { RelaySession, RelayTaskListItem, ThreadTaskContext } from "../types";
import { THREAD_TASKS_QUERY_KEY } from "./useRelayData";

/** A live round can add suggestions, change its Task, or settle it after the context read. */
export function useThreadTaskContext(
  session: RelaySession | undefined,
  context: ThreadTaskContext | undefined,
  tasks: readonly RelayTaskListItem[],
): boolean {
  const client = useQueryClient();
  const lastRequested = useRef<string | null>(null);
  let refresh: string | null = null;
  if (session && context && session.id === context.threadId && observedSessionEventCount(session) > context.eventCount) {
    const scope = session.collaborationRounds?.find((round) => round.roundId === session.activeRoundId)?.workScope;
    const taskId = scope?.kind === "task" ? scope.taskId : null;
    const nextSteps = session.nextSteps ?? [];
    const firstUnread = Math.max(0, context.eventCount - (session.eventStart ?? 0));
    const closeout = tasks.some(task => task.linkedSessionIds.includes(session.id))
      ? session.events.slice(firstUnread).reverse().find(event => event.type === "session.completed")
      : undefined;
    if (closeout || taskId !== context.activeTaskId || JSON.stringify(nextSteps) !== JSON.stringify(context.nextSteps)) {
      refresh = JSON.stringify([session.id, taskId, nextSteps, closeout?.id]);
    }
  }
  const threadId = context?.threadId;
  useEffect(() => {
    if (!refresh || !threadId) {
      lastRequested.current = null;
      return;
    }
    if (lastRequested.current === refresh) return;
    lastRequested.current = refresh;
    void client.invalidateQueries({ queryKey: [...THREAD_TASKS_QUERY_KEY, threadId], exact: true }, { cancelRefetch: false });
  }, [client, refresh, threadId]);
  return refresh === null;
}
