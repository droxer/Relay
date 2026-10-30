import type { RelayTaskListItem } from "../../types.js";
import { issueNeedsProject } from "../../lib/issueQueues.ts";
import { runNowRefused } from "../../lib/routine.ts";

/**
 * What a record can do, decided in one place from what it is.
 *
 * The list row could always start a routine; the detail could do nothing at
 * all, so a failed run had no retry and a running one had no cancel. Each
 * action is derived from the record's own state here rather than assembled
 * per surface, which is what kept Retry and Cancel from ever coexisting.
 *
 * Mark-done is the one status move kept as a button: accepting reviewed work
 * is the next step a reader came for. Every other move, Block and Unblock
 * included, is the band's status control — the same one the list row has.
 */
export type RecordAction = "run" | "retry" | "resume" | "cancel" | "done" | "delete" | "triage";

export function recordActions(
  task: Pick<RelayTaskListItem, "status" | "isRoutine" | "routineState" | "routinePauseReason" | "assignedAgentId" | "assignedTeamId" | "projectId" | "sourceRoutineId">,
  /** Set when the task belongs to a project that is closed for work. */
  options?: { readOnly?: boolean },
): readonly RecordAction[] {
  // A read-only room offers no actions at all — see `projectReadOnly`. The
  // record is still fully readable; it just cannot be acted on.
  if (options?.readOnly) return [];
  const assigned = Boolean(task.assignedAgentId || task.assignedTeamId);
  if (task.status === "running") return ["cancel"];
  // Run now works on a paused automation too; only a rate-limit pause refuses it.
  if (task.isRoutine) return assigned && !runNowRefused(task) ? ["run"] : [];
  if (task.status === "done") return [];
  const actions: RecordAction[] = [];
  // Intake: no project means nowhere to run, so the way forward is triage
  // (see lib/issueQueues). A legacy intake issue can still carry an agent;
  // offering Retry on it would only be refused.
  if (issueNeedsProject(task)) actions.push("triage");
  // A dispatch that was refused leaves the occurrence assigned and not
  // running — the state `784d23fa` made require a manual retry.
  else if (assigned && (task.status === "blocked" || task.status === "assigned")) actions.push("retry");
  if (task.status === "review") actions.push("done");
  return actions;
}

/**
 * Whether the record page offers `user` Resume on a paused automation: its
 * owner or an admin, the rule the resume route enforces.
 */
export function canManageAutomation(
  task: Pick<RelayTaskListItem, "ownerUserId">,
  user: { role: string; userId?: string },
): boolean {
  if (user.role === "admin") return true;
  return Boolean(user.userId) && task.ownerUserId === user.userId;
}
