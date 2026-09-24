import type { RelaySession, RelayTaskListItem } from "../types";

/** `tone` drives the panel rail: attention is the default, `info` is for the
 *  states that are the normal course of work (a result awaiting review, a
 *  question waiting on a human) — those need next steps, not a warning. */
export type RecoveryGuide = {
  key: string;
  destination?: "computer" | "agents" | "teams" | "projects" | "backlog";
  tone?: "info";
  /** Whether a person may assert the agent is gone. True only where the exit
   *  evidence Relay is waiting for can no longer arrive on its own: a retry
   *  repairs a failed save, but nothing repairs a computer that is never
   *  coming back, and without this the thread can never be deleted. */
  reportGone?: true;
  retrySave?: true;
};
const executionGuides: Record<string, RecoveryGuide> = {
  finalization_failed: { key: "finalization_failed" },  // the result is retained; retry saves it
  termination_unconfirmed: { key: "termination_unconfirmed", destination: "computer", reportGone: true },
  orphaned_run: { key: "orphaned_run", destination: "computer", reportGone: true },
  execution_unconfirmed: { key: "execution_unconfirmed", destination: "computer", reportGone: true },
  awaiting_dispatch: { key: "awaiting_dispatch", destination: "computer" },
  awaiting_termination: { key: "awaiting_termination", destination: "computer" },
  saving_results: { key: "saving_results" },
};

export function executionRecoveryGuide(execution?: RelaySession["execution"]): RecoveryGuide | null {
  if (!execution || execution.phase === "terminal" || execution.phase === "running") return null;
  const reason = execution.blockingReason ?? "";
  const base: RecoveryGuide = Object.hasOwn(executionGuides, reason) ? executionGuides[reason] : { key: "unknown", destination: "computer", reportGone: true };
  const { reportGone, ...guide } = base;
  const recovering = execution.phase === "recovery_required";
  return {
    ...guide,
    ...(recovering && (execution.canReportGone ?? Boolean(reportGone)) ? { reportGone: true as const } : {}),
    ...(recovering && (execution.canRetrySave ?? reason === "finalization_failed") ? { retrySave: true as const } : {}),
  };
}

// Use structured dispatch codes, never guess the cause from free-form error text.
const taskGuides: Record<string, RecoveryGuide> = {};
function register(codes: string[], key: string, destination?: RecoveryGuide["destination"]) {
  for (const code of codes) taskGuides[code] = { key, destination };
}
register(["agent_disabled", "agent_not_found", "agent_policy_unsupported", "executor_mismatch", "agent_mismatch", "task_not_assigned"], "assignment", "agents");
register(["team_not_found", "team_disabled", "team_invalid", "team_unavailable"], "assignment", "teams");
register(["project_not_found", "project_disabled", "project_roster_invalid", "project_agent_not_member", "project_agent_off_computer", "project_team_off_computer"], "assignment", "projects");
register(["agent_forbidden", "team_forbidden", "project_forbidden"], "access");
register(["agent_offline", "node_offline", "executor_not_ready", "project_computer_offline"], "offline", "computer");
register(["configuration_pending", "agent_configuration_pending"], "provisioning", "computer");
register(["workspace_unavailable"], "workspace", "computer");
register(["capacity_exhausted"], "capacity", "computer");
register(["task_wip_limit"], "wip", "backlog");
register(["task_execution_active", "dispatch_in_progress", "already_active", "dispatch_superseded"], "ownership");
register(["dispatch_retry_exhausted"], "retry_exhausted");
register(["dispatch_failed"], "failure", "computer");
register(["execution_failed", "agent_exit_failed", "execution_cancelled"], "failure");
register(["manual_block"], "manual_block");

export function taskRecoveryGuide(task: RelayTaskListItem): RecoveryGuide | null {
  if (task.status === "waiting_for_human") return { key: "human", tone: "info" };
  if (task.status === "review") return { key: "review", tone: "info" };
  if (task.status === "done") return null;
  if (task.workspaceWaiting) return { key: "ownership" };
  if (task.status === "running") return null;
  if (task.status !== "blocked" && (!task.dispatchOutcome || task.dispatchOutcome.state === "started")) return null;
  if (task.status === "blocked" && task.attention) {
    const code = task.attention.code;
    return Object.hasOwn(taskGuides, code) ? taskGuides[code] : { key: "unknown" };
  }
  if (task.status === "blocked" && (!task.blockerReason || task.blockerReason === "Execution needs attention.")) return { key: "unknown" };
  const code = task.dispatchOutcome?.state !== "started" ? task.dispatchOutcome?.code ?? "" : "";
  return Object.hasOwn(taskGuides, code) ? taskGuides[code] : { key: "failure" };
}
