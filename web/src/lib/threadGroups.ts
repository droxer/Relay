import type { ThreadItem } from "./threads.js";
import { threadAwaitsHuman, threadWaitIndex, type ThreadWaitSource } from "./awaitingInput.ts";

export type ThreadGroups = {
  needsYou: ThreadItem[];
  running: ThreadItem[];
  idle: ThreadItem[];
};

// Partition owner-scoped threads by the signal that matters for agent
// work: which threads await a human decision (needsYou), which have a live
// agent (running), and which are settled (idle). A live run overrides a
// non-running status. Input order (newest-first) is preserved within groups.
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
  const idle: ThreadItem[] = [];
  for (const item of items) {
    if (item.session.execution && item.session.execution.phase !== "terminal") {
      running.push(item);
    } else if (threadAwaitsHuman(item.session, waits)) {
      needsYou.push(item);
    } else if (!item.session.execution && (item.session.status === "running" || item.runningAgent)) {
      running.push(item);
    } else {
      idle.push(item);
    }
  }
  return { needsYou, running, idle };
}
