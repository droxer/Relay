import { taskWorkflowStage } from "./taskFlow.ts";
import type { RelayTaskListItem, TaskStatus } from "../types.js";

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

/**
 * The lane a drag is over. The board reports either a lane (dropped on its
 * empty space) or a card (dropped on a card), and a card stands for the lane
 * that holds it. `null` when the pointer is over nothing the board knows.
 */
export function laneForDropTarget<S extends string>(
  targetId: string | null,
  lanes: Readonly<Record<S, readonly { id: string }[]>>,
): S | null {
  if (targetId === null) return null;
  const statuses = Object.keys(lanes) as S[];
  if (statuses.includes(targetId as S)) return targetId as S;
  return statuses.find((status) => lanes[status].some((item) => item.id === targetId)) ?? null;
}
