import type { ThreadItem } from "./threads.js";
import { threadAwaitsHuman, threadWaitIndex, type ThreadWaitSource } from "./awaitingInput.ts";

export type ThreadGroups = {
  needsYou: ThreadItem[];
  running: ThreadItem[];
  /** Admitted runs no computer has taken yet, the longest wait first. */
  queued: ThreadItem[];
  idle: ThreadItem[];
};

/** A queue reads front to back: the run admitted first is next in line. A
 *  record from an older backend carries no admission time and sorts after
 *  every timed one, keeping its newest-first place among the untimed. */
function byQueueOrder(a: ThreadItem, b: ThreadItem): number {
  const left = a.session.execution?.queuedAt ?? "";
  const right = b.session.execution?.queuedAt ?? "";
  if (left === right) return 0;
  if (!left) return 1;
  if (!right) return -1;
  return left < right ? -1 : 1;
}

// Partition owner-scoped threads by the signal that matters for agent
// work: which threads await a human decision (needsYou), which have a live
// agent (running), which wait for a computer to take their run (queued), and
// which are settled (idle). A live or queued run overrides a non-running
// status. Input order (newest-first) is preserved within groups, except the
// queue, which reads in the order its runs were admitted.
// Waiting is read with the tasks, by the same rule as the thread's prompt: a
// thread whose task moved on is not waiting, one a waiting task names is.
export function groupThreads(
  items: readonly ThreadItem[],
  tasks: ThreadWaitSource = [],
): ThreadGroups {
  // Indexed once here, not per thread: the rail regroups on every streamed frame.
  const waits = threadWaitIndex(tasks);
  const needsYou: ThreadItem[] = [];
  const running: ThreadItem[] = [];
  const queued: ThreadItem[] = [];
  const idle: ThreadItem[] = [];
  for (const item of items) {
    if (item.session.execution?.phase === "queued") {
      queued.push(item);
    } else if (item.session.execution && item.session.execution.phase !== "terminal") {
      running.push(item);
    } else if (threadAwaitsHuman(item.session, waits)) {
      needsYou.push(item);
    } else if (!item.session.execution && (item.session.status === "running" || item.runningAgent)) {
      running.push(item);
    } else {
      idle.push(item);
    }
  }
  // Array#sort is stable, so equal admission times keep newest-first order.
  return { needsYou, running, queued: queued.sort(byQueueOrder), idle };
}
