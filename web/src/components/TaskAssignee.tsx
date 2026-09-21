import type { LogicalAgentAvailability, RelayTaskListItem } from "../types";
import { cn } from "@/lib/utils";
import { AgentStateBadge } from "./AgentStateBadge";
import { IdentityMark } from "./IdentityMark";
import { UNRESOLVED_EMPLOYEE_ID } from "../lib/taskAssignment";
import { useTranslation } from "react-i18next";

/**
 * Identity chip for a task's assignee: the owning employee's initial, their
 * handle, and — optionally — the assigned agent glyph.
 *
 * The avatar is neutral: an initial on the chip surface, no per-name hue. The
 * name beside it identifies the person, and colour stays reserved for live
 * agent work.
 */

function initialFor(name: string): string {
  const trimmed = name.trim();
  return trimmed ? trimmed[0]!.toUpperCase() : "?";
}

export function TaskAssignee({
  task,
  ready,
  availability,
  unassignedLabel,
  assigneeDisplayName,
  agentDisplayName,
  showAgent = true,
  assigneeIsSelf = false,
}: {
  task: RelayTaskListItem;
  ready: boolean;
  availability?: LogicalAgentAvailability;
  unassignedLabel: string;
  assigneeDisplayName?: string;
  agentDisplayName?: string;
  showAgent?: boolean;
  /** On personal views, hide the employee chip when it's the viewer — the
   *  executor glyph carries the assignee instead. */
  assigneeIsSelf?: boolean;
}) {
  const { t } = useTranslation();
  /* A directory miss arrives as the raw employee UUID (see
     taskAssigneeDisplayName's fallback). The team branch of the badge below
     already substitutes a label for exactly this case — the person gets the
     same courtesy, with no avatar monogram for a name nobody has. */
  const unresolved = assigneeDisplayName ? UNRESOLVED_EMPLOYEE_ID.test(assigneeDisplayName) : false;
  const assigned = Boolean(assigneeDisplayName);
  const name = unresolved ? t("backlog.assignee_unknown") : assigneeDisplayName ?? unassignedLabel;

  return (
    <span className="task-assignee" translate="no" data-unassigned={assigned ? "false" : "true"}>
      {assigneeIsSelf ? null : (
        <>
          <span className="task-assignee-avatar" aria-hidden="true">
            {assigned && !unresolved ? initialFor(name) : null}
          </span>
          <span className="task-assignee-name">{name}</span>
        </>
      )}
      {showAgent ? <TaskExecutionBadge task={task} ready={ready} availability={availability} displayName={agentDisplayName} /> : null}
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
