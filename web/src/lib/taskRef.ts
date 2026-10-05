import type { RelayTaskListItem } from "../types.js";

/** Automations count apart from issues, so their refs carry their own prefix. */
export const AUTOMATION_REF_PREFIX = "AUTO";

export type TaskRefSource = Pick<RelayTaskListItem, "id" | "number"> & { isRoutine?: boolean };

/** The ref a person reads and types: `#12` for an issue, `AUTO-3` for an
 * automation. A task the backend has not numbered yet falls back to its id. */
export function taskRef(task: TaskRefSource): string {
  if (task.number == null) return task.id;
  return task.isRoutine ? `${AUTOMATION_REF_PREFIX}-${task.number}` : `#${task.number}`;
}
