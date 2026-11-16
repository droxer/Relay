import { useEffect, useState } from "react";
import type { RelaySession } from "../types";
import { nextQueueGraceEnd } from "../lib/queuedRun";
import { useMinuteClock } from "./useMinuteClock";

/**
 * The minute clock, plus a wake-up when a queued run's grace ends — so a run
 * that is still queued once its grace passes turns from "running" into
 * "queued" on time rather than at the next minute tick.
 */
export function useQueueClock(sessions: readonly Pick<RelaySession, "execution">[]): number {
  const minute = useMinuteClock();
  const [woke, setWoke] = useState(minute);
  const now = Math.max(minute, woke);
  const wakeAt = nextQueueGraceEnd(sessions, now);
  useEffect(() => {
    if (wakeAt === null) return;
    const timer = window.setTimeout(() => setWoke(Date.now()), Math.max(0, wakeAt - Date.now()) + 1);
    return () => window.clearTimeout(timer);
  }, [wakeAt]);
  return now;
}
