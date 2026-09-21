import type { LogicalAgentAvailability, RelayTaskListItem } from "../types";
import { cn } from "@/lib/utils";
import { AgentStateBadge } from "./AgentStateBadge";
import { IdentityMark } from "./IdentityMark";
import { taskAssigneeLabel } from "../lib/taskAssignment";
import { useTranslation } from "react-i18next";

/** Every task shows its assigned agent/team as a visible name. */
export function TaskAssignee({
  task,
  ready,
  availability,
  agentDisplayName,
}: {
  task: RelayTaskListItem;
  ready: boolean;
  availability?: LogicalAgentAvailability;
  agentDisplayName?: string;
}) {
  const { t } = useTranslation();
  const assigned = Boolean(task.assignedAgentId || task.assignedAgent || task.assignedTeamId);
  const name = taskAssigneeLabel(task, agentDisplayName, t);
  return (
    <span className="task-assignee" translate="no" data-unassigned={assigned ? "false" : "true"}>
      {assigned && (task.assignedAgent || task.assignedTeamId) ? (
        <TaskExecutionBadge task={task} ready={ready} availability={availability} displayName={agentDisplayName} />
      ) : null}
      <span className="task-assignee-name" title={name}>{name}</span>
    </span>
  );
}

export function TaskExecutionBadge({
  task,
  ready,
  availability,
  displayName,
}: {
  task: RelayTaskListItem;
  ready: boolean;
  availability?: LogicalAgentAvailability;
  displayName?: string;
}) {
  const { t } = useTranslation();
  if (task.assignedTeamId) {
    // A team the roster no longer returns (deleted or scoped out) falls back
    // to the same placeholder the task drawer draws — never the raw team id.
    const name = displayName ?? t("backlog.assignment_unavailable_team");
    // Mirror AgentStateBadge: the team's default profile image (name monogram
    // on its identity hue) carries identity, the readiness pip carries status
    // (same tri-state mapping — busy = info, pending = warn, never collapsed
    // to bad while healthy), and the full label is sr-only text + tooltip so
    // cards stay scannable.
    const tone = availability
      ? availability === "ready"
        ? "tone-good"
        : availability === "offline"
          ? "tone-bad"
          : availability === "busy"
            ? "tone-info"
            : "tone-warn"
      : ready
        ? "tone-good"
        : "tone-bad";
    const stateLabel = availability
      ? t(`status.${availability}`, { defaultValue: availability })
      : ready
        ? t("backlog.ready")
        : t("backlog.not_ready");
    const label = `${t("teams.assignment_badge", { name })} · ${stateLabel}`;
    return (
      <span className={cn("agent-state", "agent-state--team", tone)} title={label}>
        <IdentityMark kind="team" />
        <span className="sr-only">{label}</span>
      </span>
    );
  }
  return <AgentStateBadge agent={task.assignedAgent} ready={ready} availability={availability} name={displayName} />;
}
