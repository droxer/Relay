"use client";

import { useTranslation } from "react-i18next";
import { Field } from "@/components/ui/field";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { AgentTeam, EmployeeAgent } from "../../types";
import { teamAvailability } from "../../lib/taskAssignment";
import { parseTaskAssignmentValue, type TaskAssignmentSelection } from "../../lib/taskBoardForm";
import { navigateToAppPath } from "../../lib/appRoute";
import { AgentMark } from "../AgentMark";
import { IdentityMark } from "../IdentityMark";
import { ProfileImage } from "../ProfileImagePicker";
import { ICON, NavAgents, NavTeams } from "../icons";
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

export const NO_ASSIGNMENT = "__none__";
const NAV_AGENTS = "__nav_agents__";
const NAV_TEAMS = "__nav_teams__";

export type AssignmentSelection = TaskAssignmentSelection;
export type { AgentView, TeamView };
export { availabilityTone, effectiveAgentAvailability };

type AssignmentTab = "agents" | "teams";

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
        <span className="task-assignment-summary-meta">
          {agent
            ? t("backlog.agent_descriptor", { executor: agent.executorKind })
            : t("backlog.team_descriptor", {
                count: team?.members.length ?? 0,
                lead: leadName ?? t("backlog.team_no_lead"),
              })}
        </span>
        {team && team.members.length > 0 ? (
          <span className="task-assignment-roster" aria-label={t("backlog.team_roster")}>
            {team.members.slice(0, 5).map((member) => (
              <span key={member.id} className="task-assignment-member" title={member.displayName}>
                <AgentMark agent={member.executorKind} size={ICON.xs} />
              </span>
            ))}
            {team.members.length > 5 ? <span className="task-assignment-member-more">+{team.members.length - 5}</span> : null}
          </span>
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
}: {
  /** `agent:<id>`, `team:<id>`, or `NO_ASSIGNMENT`. */
  value: string;
  agents: EmployeeAgent[];
  teams: AgentTeam[];
  /** Resolved views for the current value — may be placeholders for a roster
   *  entry that has since been deleted. */
  selectedAgent?: AgentView;
  selectedTeam?: TeamView;
  onSelect: (selection: AssignmentSelection) => void;
  triggerId?: string;
  describedBy?: string;
  autoFocus?: boolean;
}) {
  const { t } = useTranslation();
  const selectedTab: AssignmentTab = selectedTeam ? "teams" : "agents";
  const tabs: RosterTab<AssignmentTab>[] = [
    { id: "agents", label: t("backlog.agents_section"), count: agents.length },
    { id: "teams", label: t("backlog.teams_section"), count: teams.length },
  ];
  const roster = useRosterTabs({ tabs, activeTab: selectedTab, label: t("backlog.assignment_label") });

  return (
    <Select
      value={value}
      onOpenChange={(open) => {
        if (open) roster.resetTab();
      }}
      onValueChange={(next) => {
        if (next == null) return;
        if (next === NAV_AGENTS) {
          navigateToAppPath("/agents");
          return;
        }
        if (next === NAV_TEAMS) {
          navigateToAppPath("/teams?dialog=create");
          return;
        }
        onSelect(parseTaskAssignmentValue(next));
      }}
    >
      <SelectTrigger
        id={triggerId}
        aria-describedby={describedBy}
        className="w-full"
        data-modal-initial-focus={autoFocus ? "" : undefined}
      >
        <SelectValue>
          {(current: string) => {
            if (current === NO_ASSIGNMENT) return t("backlog.assign_later");
            if (selectedTeam) return <RosterTriggerValue team={selectedTeam} />;
            if (selectedAgent) return <RosterTriggerValue agent={selectedAgent} />;
            return t("backlog.assign_later");
          }}
        </SelectValue>
      </SelectTrigger>
      <SelectContent
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
  ...select
}: Parameters<typeof AssignmentSelect>[0] & {
  fieldId: string;
  summaryId: string;
  emptyHint: string;
}) {
  const { t } = useTranslation();
  return (
    <Field
      label={t("backlog.assignment_label")}
      wrapper="div"
      htmlFor={fieldId}
      className="task-assignment-field"
    >
      <AssignmentSelect {...select} triggerId={fieldId} describedBy={summaryId} />
      <AssignmentSummary
        id={summaryId}
        agent={select.selectedAgent}
        team={select.selectedTeam}
        emptyHint={emptyHint}
      />
    </Field>
  );
}
