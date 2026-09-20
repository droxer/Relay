import type { RelayTaskListItem } from "../../types.js";

/**
 * What a record can do, decided in one place from what it is.
 *
 * The list row could always start a routine; the detail could do nothing at
 * all, so a failed run had no retry and a running one had no cancel. Each
 * action is derived from the record's own state here rather than assembled
 * per surface, which is what kept Retry and Cancel from ever coexisting.
 */
export type RecordAction = "run" | "retry" | "cancel";

export function recordActions(
  task: Pick<RelayTaskListItem, "status" | "isRoutine" | "routineEnabled" | "assignedAgentId" | "assignedTeamId">,
): readonly RecordAction[] {
  const assigned = Boolean(task.assignedAgentId || task.assignedTeamId);
  if (task.status === "running") return ["cancel"];
  if (task.isRoutine) return assigned && task.routineEnabled ? ["run"] : [];
  // A dispatch that was refused leaves the occurrence assigned and not
  // running — the state `784d23fa` made require a manual retry.
  if (task.status === "blocked" || task.status === "assigned") return assigned ? ["retry"] : [];
  return [];
}
