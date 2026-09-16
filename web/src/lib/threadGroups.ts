import type { ThreadItem } from "./threads.js";

export type ThreadGroups = {
  needsYou: ThreadItem[];
  running: ThreadItem[];
  idle: ThreadItem[];
};

// Partition owner-scoped threads by the signal that matters for agent
// work: which threads await a human decision (needsYou), which have a live
// agent (running), and which are settled (idle). A live run overrides a
// non-running status. Input order (newest-first) is preserved within groups.
export function groupThreads(
  items: readonly ThreadItem[],
): ThreadGroups {
  const needsYou: ThreadItem[] = [];
  const running: ThreadItem[] = [];
  const idle: ThreadItem[] = [];
  for (const item of items) {
    if (item.session.execution && item.session.execution.phase !== "terminal") {
      running.push(item);
    } else if (item.session.status === "waiting_for_human") {
      needsYou.push(item);
    } else if (!item.session.execution && (item.session.status === "running" || item.runningAgent)) {
      running.push(item);
    } else {
      idle.push(item);
    }
  }
  return { needsYou, running, idle };
}
