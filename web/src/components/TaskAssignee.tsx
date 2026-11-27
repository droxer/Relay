import type { LogicalAgentAvailability, RelayTaskListItem } from "../types";
import { cn } from "@/lib/utils";
import { AgentStateBadge } from "./AgentStateBadge";
import { IdentityMark } from "./IdentityMark";
import { ProfileImage } from "./ProfileImagePicker";
import { taskAssigneeLabel } from "../lib/taskAssignment";
import { useTranslation } from "react-i18next";
import { ICON, NavRoutine } from "./icons";
import { predefinedStyle } from "../lib/workflowSelection";
import { PredefinedWorkflowIcon } from "./workflow/PredefinedWorkflowIcon";
import { agentRoleLabel, type AgentRoleIdentity } from "../lib/agentRoleLabel";
import { AgentRoleMeta } from "./RoleLevelBadge";

/** Every task shows its assigned agent/team as a visible name. */
export function TaskAssignee({
  task,
  ready,
  availability,
  agentDisplayName,
  agentImageUrl,
  agentRole,
}: {
  task: RelayTaskListItem;
  ready: boolean;
  availability?: LogicalAgentAvailability;
  agentDisplayName?: string;
  agentImageUrl?: string | null;
  agentRole?: AgentRoleIdentity;
}) {
  const { t } = useTranslation();
  const workflow = Boolean(task.assignedWorkflowId && !task.assignedTeamId && !task.assignedAgentId);
  const style = predefinedStyle(task.assignedWorkflowId);
  const assigned = Boolean(workflow || task.assignedAgentId || task.assignedAgent || task.assignedTeamId);
  const name = taskAssigneeLabel(task, agentDisplayName, t);
  const role = agentRoleLabel(agentRole, t);
  return (
    <span className="task-assignee" data-unassigned={assigned ? "false" : "true"}>
      {workflow ? (
        style ? <PredefinedWorkflowIcon style={style} /> : <NavRoutine size={ICON.sm} aria-label={t("workflow.assigned_workflow")} />
      ) : assigned ? (
        <TaskExecutionBadge task={task} ready={ready} availability={availability} displayName={name} imageUrl={agentImageUrl} />
      ) : null}
      <span className="agent-identity-copy" title={role ? `${name} · ${role}` : name}>
        <span className="task-assignee-name" translate="no">{name}</span>
        <AgentRoleMeta identity={agentRole} />
      </span>
    </span>
  );
}

function TaskExecutionBadge({
  task,
  ready,
  availability,
  displayName,
  imageUrl,
}: {
  task: RelayTaskListItem;
  ready: boolean;
  availability?: LogicalAgentAvailability;
  displayName?: string;
  imageUrl?: string | null;
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
        <ProfileImage src={imageUrl} alt="" fallback={<IdentityMark kind="team" />} />
        <span className="sr-only">{label}</span>
      </span>
    );
  }
  return <AgentStateBadge agent={task.assignedAgent} ready={ready} availability={availability} name={displayName} imageUrl={imageUrl} />;
}
