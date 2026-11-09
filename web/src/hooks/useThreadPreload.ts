import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { getSession } from "../api";
import type { RelaySession } from "../types";
import { mergeSessionSnapshotIntoSessions } from "../lib/sessionPollMerge";
import { applySessionEventUnchecked } from "../lib/sessionEvents";
import { threadPreloadKey } from "../lib/threadPreload";
import { SESSIONS_QUERY_KEY } from "./useRelayData";

/** Detail fetches in flight at once, so preloading never crowds out the
 *  thread the reader actually opened. */
const PRELOAD_CONCURRENCY = 2;
const IDLE_TIMEOUT_MS = 1500;

type PreloadRun = {
  controller: AbortController;
  queue: string[];
  attempted: Set<string>;
  active: number;
};

function whenIdle(task: () => void): void {
  if (typeof window.requestIdleCallback === "function") {
    window.requestIdleCallback(task, { timeout: IDLE_TIMEOUT_MS });
  } else {
    window.setTimeout(task, 0);
  }
}

/**
 * Preload the full record of every first-page thread, so opening one from the
 * rail or Home renders its transcript at once instead of after a round trip.
 * Each thread is fetched once per sign-in; a failure is left to the thread's
 * own fetch when it is opened. Runs at idle time, two at a time.
 */
export function useThreadPreload(sessions: readonly RelaySession[], enabled: boolean): void {
  const queryClient = useQueryClient();
  const runRef = useRef<PreloadRun | null>(null);
  const key = enabled ? threadPreloadKey(sessions) : "";

  useEffect(() => {
    if (!enabled) return;
    const run: PreloadRun = { controller: new AbortController(), queue: [], attempted: new Set(), active: 0 };
    runRef.current = run;
    return () => {
      run.controller.abort();
      if (runRef.current === run) runRef.current = null;
    };
  }, [enabled]);

  useEffect(() => {
    const run = runRef.current;
    if (!run || !key) return;
    const pump = () => {
      while (run.active < PRELOAD_CONCURRENCY && run.queue.length > 0 && !run.controller.signal.aborted) {
        const sessionId = run.queue.shift() as string;
        run.active += 1;
        whenIdle(() => {
          if (run.controller.signal.aborted) return;
          getSession(sessionId, run.controller.signal)
            .then((snapshot) => {
              if (run.controller.signal.aborted) return;
              // Only into a thread still listed: one closed while its preload
              // was in flight must not come back.
              queryClient.setQueryData<RelaySession[]>(SESSIONS_QUERY_KEY, (current) =>
                current?.some((session) => session.id === snapshot.id)
                  ? mergeSessionSnapshotIntoSessions(current, snapshot, applySessionEventUnchecked)
                  : current);
            })
            .catch(() => {
              // Not retried here: opening the thread fetches it again.
            })
            .finally(() => {
              run.active -= 1;
              pump();
            });
        });
      }
    };
    for (const sessionId of key.split("\n")) {
      if (run.attempted.has(sessionId)) continue;
      run.attempted.add(sessionId);
      run.queue.push(sessionId);
    }
    pump();
  }, [enabled, key, queryClient]);
}
