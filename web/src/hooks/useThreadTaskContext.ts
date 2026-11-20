"use client";

import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { observedSessionEventCount } from "../lib/sessionPollMerge";
import type { RelaySession, ThreadTaskContext } from "../types";
import { THREAD_TASKS_QUERY_KEY } from "./useRelayData";

/** A live round can add suggestions or change its Task after the context read.
 * Ordinary transcript deltas don't change which rows the context needs. */
export function useThreadTaskContext(session: RelaySession | undefined, context: ThreadTaskContext | undefined): boolean {
  const client = useQueryClient();
  const lastRequested = useRef<string | null>(null);
  let refresh: string | null = null;
  if (session && context && session.id === context.threadId && observedSessionEventCount(session) > context.eventCount) {
    const scope = session.collaborationRounds?.find((round) => round.roundId === session.activeRoundId)?.workScope;
    const taskId = scope?.kind === "task" ? scope.taskId : null;
    const nextSteps = session.nextSteps ?? [];
    if (taskId !== context.activeTaskId || JSON.stringify(nextSteps) !== JSON.stringify(context.nextSteps)) {
      refresh = JSON.stringify([session.id, taskId, nextSteps]);
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
    void client.invalidateQueries({ queryKey: [...THREAD_TASKS_QUERY_KEY, threadId], exact: true });
  }, [client, refresh, threadId]);
  return refresh === null;
}
