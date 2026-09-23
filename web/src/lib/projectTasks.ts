import { compareTaskQueue } from "./taskFlow.ts";
import type { RelayTaskListItem } from "../types.js";

/**
 * What a project's task list is made of.
 *
 * The list used to derive all of this inline, and drifted from the backlog
 * it mirrors. Deriving it here — once, in terms the backlog already uses
 * (`compareTaskQueue`) — is what keeps the two surfaces saying the same
 * thing about the same task.
 */

/** One project's live, non-routine tasks, in the queue order the backlog uses. */
export function projectTaskQueue(
  tasks: readonly RelayTaskListItem[],
  projectId: string,
): RelayTaskListItem[] {
  return tasks
    .filter((task) => task.projectId === projectId && !task.isRoutine && !task.deletedAt)
    .sort(compareTaskQueue);
}

export type ProjectTaskProgress = {
  done: number;
  total: number;
  /** Tasks stopped on a human — blocked, or waiting for an answer. */
  attention: number;
  /** Completion as a whole percent; 0 for an empty project rather than NaN. */
  percent: number;
};

export function projectTaskProgress(work: readonly RelayTaskListItem[]): ProjectTaskProgress {
  const done = work.filter((task) => task.status === "done").length;
  const attention = work.filter(
    (task) => task.status === "blocked" || task.status === "waiting_for_human",
  ).length;
  const total = work.length;
  return { done, total, attention, percent: total ? Math.round((done / total) * 100) : 0 };
}
