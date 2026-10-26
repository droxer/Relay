import type { RelayTaskListItem } from "../types.ts";
import { taskRef } from "./taskRef.ts";

/**
 * Task prerequisites as the web reads them. The backend owns the rules —
 * same project, acyclic, at most `PREREQUISITES_MAX` — and derives
 * `waitingOn` (backend/relay/tasks/prerequisites.py); this module only
 * mirrors what a picker should offer, so a refusal is rare rather than
 * impossible. A cycle is still caught only by the server.
 */
export const PREREQUISITES_MAX = 10;

type TaskLookup = ReadonlyMap<string, Pick<RelayTaskListItem, "id" | "number" | "isRoutine" | "title">>;

/** The prerequisites still in the way, as refs (`#3`); an id the lookup does
 *  not know stays visible as itself rather than vanishing. */
export function waitingOnRefs(task: Pick<RelayTaskListItem, "waitingOn">, tasks: TaskLookup): string[] {
  return (task.waitingOn ?? []).map((id) => {
    const prerequisite = tasks.get(id);
    return prerequisite ? taskRef(prerequisite) : id;
  });
}

/** Whether a task is held only by unfinished prerequisites: ready or queued
 *  work that the scheduler will start once they are done. */
export function waitsOnPrerequisites(task: Pick<RelayTaskListItem, "status" | "waitingOn">): boolean {
  return Boolean(task.waitingOn?.length) && (task.status === "assigned" || task.status === "backlog");
}

/** Tasks a picker may offer as prerequisites of `task`: live, non-automation
 *  tasks in its project, other than itself and the tasks that already wait
 *  on it directly (choosing one would close a cycle). */
export function prerequisiteCandidates<T extends RelayTaskListItem>(
  task: Pick<RelayTaskListItem, "id" | "projectId" | "unblocks">,
  tasks: readonly T[],
): T[] {
  if (!task.projectId) return [];
  const dependents = new Set(task.unblocks ?? []);
  return tasks.filter((candidate) =>
    candidate.id !== task.id
    && candidate.projectId === task.projectId
    && !candidate.isRoutine
    && !candidate.deletedAt
    && !dependents.has(candidate.id));
}
