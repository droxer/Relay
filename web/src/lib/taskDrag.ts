import { taskWorkflowStage } from "./taskFlow.ts";
import type { RelayTaskListItem, TaskStatus } from "../types.js";

/**
 * Board drags carry only the task id, under a Relay-specific media type so a
 * drag originating outside the board (a file, a text selection) never resolves
 * to a task. `text/plain` is set alongside it purely so the OS drag image and
 * cross-window drops degrade sensibly — it is not read back.
 */
export const TASK_DRAG_MEDIA_TYPE = "application/x-relay-task-id";

export type TaskDropRejection = "same_status" | "needs_assignment" | "invalid_transition";

/**
 * Why a lane refuses a dropped task, or `null` when the move is allowed.
 * `needs_assignment` mirrors the backend rule that the `assigned` status
 * requires an agent or a team, so the board never issues a PATCH it knows
 * will come back 400.
 */
export function taskDropRejection(task: RelayTaskListItem, status: TaskStatus): TaskDropRejection | null {
  if (taskWorkflowStage(task) === status) return "same_status";
  if (task.status === "running" || task.status === "blocked") return "invalid_transition";
  if (status === "waiting_for_human" || status === "blocked") return "invalid_transition";
  if (status === "running" && !["backlog", "assigned"].includes(task.status)) return "invalid_transition";
  if (status === "review" && !task.startedAt) return "invalid_transition";
  if (status === "done" && task.status !== "review") return "invalid_transition";
  if (status === "backlog" && task.startedAt) return "invalid_transition";
  if ((status === "assigned" || status === "running") && !task.projectId && !task.assignedAgentId && !task.assignedTeamId) return "needs_assignment";
  return null;
}

export function readDraggedTaskId(transfer: DataTransfer | null): string | null {
  const id = transfer?.getData(TASK_DRAG_MEDIA_TYPE)?.trim();
  return id ? id : null;
}
