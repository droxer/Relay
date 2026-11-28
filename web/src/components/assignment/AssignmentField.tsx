"use client";

import { type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Field } from "@/components/ui/field";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { AgentTeam, UserAgent } from "../../types";
import { projectWorkflowName, type ProjectWorkflowOption } from "../../lib/workflowSelection";
import { teamAvailability } from "../../lib/taskAssignment";
import { AgentRoleMeta } from "../RoleLevelBadge";
import { parseTaskAssignmentValue, type TaskAssignmentSelection } from "../../lib/taskBoardForm";
import { navigateToAppPath } from "../../lib/appRoute";
import { AvatarStack } from "../AvatarStack";
import { IdentityMark } from "../IdentityMark";
import { ProfileImage } from "../ProfileImagePicker";
import { ICON, NavAgents, NavTeams, NavWorkflows } from "../icons";
import {
  availabilityTone,
  effectiveAgentAvailability,
  RosterActionOption,
  RosterAgentItem,
  RosterEmptyOption,
  RosterTeamItem,
  RosterTriggerValue,
  type AgentView,
  type TeamView,
} from "../roster/RosterOption";
import { rosterLabel, useRosterTabs, type RosterTab } from "../roster/RosterTabs";
import { ProjectWorkflowOptionLabel } from "../workflow/ProjectWorkflowSelect";

const NO_ASSIGNMENT = "__none__";
const NAV_AGENTS = "__nav_agents__";
const NAV_TEAMS = "__nav_teams__";
const NAV_WORKFLOWS = "__nav_workflows__";

type AssignmentSelection = TaskAssignmentSelection;
export type { AgentView, TeamView };
export { availabilityTone, effectiveAgentAvailability };

type AssignmentTab = "agents" | "teams" | "workflows";

function AssignmentSummary({
  agent,
  team,
  emptyHint,
  id,
}: {
  agent?: AgentView;
  team?: TeamView;
  emptyHint: string;
  id: string;
}) {
  const { t } = useTranslation();
  const availability = team
    ? teamAvailability(team)
    : agent
      ? effectiveAgentAvailability(agent)
      : undefined;

  if (!agent && !team) {
    return (
      <span id={id} className="task-assignment-summary is-empty" aria-live="polite">
        <span className="task-assignment-summary-mark" aria-hidden="true">
          <NavAgents size={ICON.xl} />
        </span>
        <span className="task-assignment-summary-copy">
          <span className="task-assignment-summary-title">{t("backlog.assign_later")}</span>
          <span className="task-assignment-summary-meta">{emptyHint}</span>
        </span>
      </span>
    );
  }

  const ready = availability === "ready";
  const leadName = team?.lead?.displayName;
  const name = agent?.displayName ?? team?.name ?? "";
  const description = agent
    ? undefined
    : t("backlog.team_descriptor", {
        count: team?.members.length ?? 0,
        lead: leadName ?? t("backlog.team_no_lead"),
      });
  const statusLabel = availability ? t(`status.${availability}`, { defaultValue: availability }) : "";
  return (
    <span
      id={id}
      className="task-assignment-summary"
      data-tone={availability ? availabilityTone(availability).replace("tone-", "") : undefined}
      aria-live="polite"
    >
      <span className="task-assignment-summary-mark" role="img" aria-label={`${name} · ${statusLabel}`}>
        {agent ? (
          <ProfileImage
            src={agent.profileImageUrl}
            alt=""
            fallback={<IdentityMark kind="agent" />}
          />
        ) : (
          <ProfileImage src={team?.profileImageUrl} alt="" fallback={team ? <IdentityMark kind="team" /> : null} />
        )}
      </span>
      <span className="task-assignment-summary-body">
        <span className="task-assignment-summary-head">
          <span className="task-assignment-summary-title">{name}</span>
        </span>
        {agent ? (
          <AgentRoleMeta identity={agent} className="task-assignment-summary-meta" />
        ) : description ? (
          <span className="task-assignment-summary-meta">{description}</span>
        ) : null}
        {team && team.members.length > 0 ? (
          <AvatarStack
            className="task-assignment-roster"
            label={t("backlog.team_roster")}
            max={5}
            items={team.members.map((member) => ({
              id: member.id,
              name: member.displayName,
              mark: <ProfileImage src={member.profileImageUrl} alt="" fallback={<IdentityMark kind="agent" />} />,
            }))}
          />
        ) : null}
        {availability && !ready ? (
          <span className="task-assignment-summary-hint">{t("backlog.assignment_waiting_hint")}</span>
        ) : null}
      </span>
    </span>
  );
}

/**
 * The task board's agent/team picker: the shared roster popup (see
 * `roster/RosterTabs`) over the assignment value a task carries, plus the two
 * nav rows that let a drawer reach the rosters it is choosing from.
 *
 * Both rosters are always offered here — even an empty one keeps its tab and
 * says so — because assignment is the decision that determines whether a task
 * can run, and "there are no teams yet" is an answer the drawer owes the user.
 */
export function AssignmentSelect({
  value,
  agents,
  teams,
  selectedAgent,
  selectedTeam,
  onSelect,
  triggerId,
  describedBy,
  autoFocus = false,
  inline,
  hideAgents = false,
  hideTeams = false,
  workflows,
  workflowMessage,
  workflowAction,
  onOpenChange,
}: {
  /** `agent:<id>`, `team:<id>`, or `NO_ASSIGNMENT`. */
  value: string;
  agents: UserAgent[];
  teams: AgentTeam[];
  /** Resolved views for the current value — may be placeholders for a roster
   *  entry that has since been deleted. */
  selectedAgent?: AgentView;
  selectedTeam?: TeamView;
  onSelect: (selection: AssignmentSelection) => void;
  triggerId?: string;
  describedBy?: string;
  autoFocus?: boolean;
  hideAgents?: boolean;
  hideTeams?: boolean;
  workflows?: ProjectWorkflowOption[];
  workflowMessage?: string;
  workflowAction?: { label: string; href: string };
  onOpenChange?: (open: boolean) => void;
  /** A list row's compact trigger: the row's own assignee chip, named by
   *  `label`, instead of the drawer's full-width field. */
  inline?: { label: string; content: ReactNode };
}) {
  const { t } = useTranslation();
  const selectedTab: AssignmentTab = value.startsWith("workflow:") && workflows ? "workflows"
    : (hideAgents || selectedTeam) && !hideTeams ? "teams" : "agents";
  const tabs: RosterTab<AssignmentTab>[] = [
    ...(!hideAgents ? [{ id: "agents", label: t("backlog.agents_section"), count: agents.length } satisfies RosterTab<AssignmentTab>] : []),
    ...(workflows ? [{ id: "workflows" as const, label: t("workflow.workflows"), count: workflows.length }] : []),
    ...(!hideTeams ? [{ id: "teams" as const, label: t("backlog.teams_section"), count: teams.length }] : []),
  ];
  const roster = useRosterTabs({ tabs, activeTab: selectedTab, label: t("backlog.assignment_label") });

  return (
    <Select
      value={value}
      onOpenChange={(open) => {
        if (open) roster.resetTab();
        onOpenChange?.(open);
      }}
      onValueChange={(next) => {
        if (next == null) return;
        if (next === NAV_AGENTS) {
          navigateToAppPath("/agents");
          return;
        }
        if (next === NAV_TEAMS) {
          navigateToAppPath("/workflows?dialog=create");
          return;
        }
        if (next === NAV_WORKFLOWS) {
          navigateToAppPath(workflowAction?.href ?? "/workflows?dialog=create");
          return;
        }
        onSelect(parseTaskAssignmentValue(next));
      }}
    >
      {inline ? (
        <SelectTrigger className="inline-field inline-field--assignee" aria-label={inline.label}>
          {inline.content}
        </SelectTrigger>
      ) : (
      <SelectTrigger
        id={triggerId}
        aria-describedby={describedBy}
        className="w-full"
        data-modal-initial-focus={autoFocus ? "" : undefined}
      >
        <SelectValue>
          {(current: string) => {
            if (current === NO_ASSIGNMENT) return t("backlog.assign_later");
            const selection = parseTaskAssignmentValue(current);
            if (selection.kind === "workflow") {
              const workflow = workflows?.find((option) => option.id === selection.id);
              return projectWorkflowName(selection.id, t, workflow?.kind === "steps" ? workflow.name : undefined)
                ?? workflowMessage ?? t("workflow.unavailable");
            }
            if (selectedTeam) return <RosterTriggerValue team={selectedTeam} />;
            if (selectedAgent) return <RosterTriggerValue agent={selectedAgent} />;
            return t("backlog.assign_later");
          }}
        </SelectValue>
      </SelectTrigger>
      )}
      <SelectContent
        /* A row trigger is a chip, far narrower than the drawer's field; the
           popup keeps the width its option rows need either way. */
        className={inline ? "min-w-60" : undefined}
        alignItemWithTrigger={false}
        onKeyDownCapture={roster.onKeyDownCapture}
        header={roster.header}
      >
        {/* One group so the rows keep the popup's inner padding, named by the
            active tab so a reader hears which roster it just moved into. */}
        <SelectGroup aria-label={rosterLabel(tabs, roster.tab)}>
          <RosterEmptyOption value={NO_ASSIGNMENT} label={t("backlog.assign_later")} />
          {roster.tab === "agents" ? (
            <>
              {agents.map((agent) => (
                <RosterAgentItem key={agent.id} value={`agent:${agent.id}`} agent={agent} />
              ))}
              {agents.length === 0 ? (
                <RosterEmptyOption value="__empty_agents__" label={t("backlog.no_agents_available")} disabled />
              ) : null}
              <RosterActionOption value={NAV_AGENTS} label={t("backlog.manage_agents")} icon={<NavAgents size={ICON.sm} />} />
            </>
          ) : roster.tab === "workflows" ? (
            <>
              {workflows?.map(workflow => <SelectItem key={workflow.id} value={`workflow:${workflow.id}`} disabled={Boolean(workflow.issue)}>
                <ProjectWorkflowOptionLabel option={workflow} />
              </SelectItem>)}
              {!workflowMessage && workflows?.length === 0 ? (
                <RosterEmptyOption value="__empty_workflows__" label={t("workflows.no_workflows_available")} disabled />
              ) : null}
              {workflowMessage ? <RosterEmptyOption value="__workflow_status__" label={workflowMessage} disabled /> : null}
              {workflowAction ? (
                <RosterActionOption value={NAV_WORKFLOWS} label={workflowAction.label} icon={<NavWorkflows size={ICON.sm} />} />
              ) : null}
            </>
          ) : (
            <>
              {teams.map((team) => (
                <RosterTeamItem key={team.id} value={`team:${team.id}`} team={team} />
              ))}
              {teams.length === 0 ? (
                <RosterEmptyOption value="__empty_teams__" label={t("backlog.no_teams_available")} disabled />
              ) : null}
              <RosterActionOption value={NAV_TEAMS} label={t("backlog.create_team")} icon={<NavTeams size={ICON.sm} />} />
            </>
          )}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}

/** Labelled assignment control: the tabbed picker plus the readiness summary
 *  that spells out what the choice means. Drawers render this, not the raw
 *  select, so the summary never drifts between surfaces. */
export function AssignmentField({
  fieldId,
  summaryId,
  emptyHint,
  compact = false,
  switcher,
  alternate,
  ...select
}: Parameters<typeof AssignmentSelect>[0] & {
  fieldId: string;
  summaryId: string;
  emptyHint: string;
  /** The picker already shows the selection. Only add a note if it must wait. */
  compact?: boolean;
  /** A control above the picker that chooses what kind of assignee this is
   *  (the drawer's Agent | Workflow switch). */
  switcher?: ReactNode;
  /** Replaces the picker and its summary while the switcher chooses another
   *  kind. Kept inside this one field so flipping the switch never remounts
   *  it and focus stays on the segment the reader pressed. */
  alternate?: ReactNode;
}) {
  const { t } = useTranslation();
  const availability = select.selectedTeam ? teamAvailability(select.selectedTeam)
    : select.selectedAgent ? effectiveAgentAvailability(select.selectedAgent) : undefined;
  const waiting = compact && availability && availability !== "ready";
  return (
    <Field
      label={t("backlog.assignment_label")}
      wrapper="div"
      htmlFor={alternate ? undefined : fieldId}
      className="task-assignment-field"
    >
      {switcher}
      {alternate ?? (
        <>
          <AssignmentSelect {...select} triggerId={fieldId} describedBy={!compact || waiting ? summaryId : undefined} />
          {waiting ? (
            <p id={summaryId} className="adm-form-hint" role="status">{t("backlog.assignment_waiting_hint")}</p>
          ) : null}
          {!compact ? <AssignmentSummary
            id={summaryId}
            agent={select.selectedAgent}
            team={select.selectedTeam}
            emptyHint={emptyHint}
          /> : null}
        </>
      )}
    </Field>
  );
}
