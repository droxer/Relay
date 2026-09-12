"use client";

import { useState, type KeyboardEvent, type ReactNode } from "react";
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
import { cn } from "@/lib/utils";
import type { AgentTeam, EmployeeAgent, LogicalAgentAvailability } from "../../types";
import { teamAvailability } from "../../lib/taskAssignment";
import { parseTaskAssignmentValue, type TaskAssignmentSelection } from "../../lib/taskBoardForm";
import { navigateToAppPath } from "../../lib/appRoute";
import { AgentMark } from "../AgentMark";
import { AgentStateBadge } from "../AgentStateBadge";
import { IdentityMark } from "../IdentityMark";
import { ProfileImage } from "../ProfileImagePicker";
import { ICON, NavAgents, NavTeams } from "../icons";

export const NO_ASSIGNMENT = "__none__";
const NAV_AGENTS = "__nav_agents__";
const NAV_TEAMS = "__nav_teams__";

export type AssignmentSelection = TaskAssignmentSelection;

// The picker only reads a handful of fields off an agent/team, so accept a
// narrowed view. This lets a caller synthesize a placeholder for an assignment
// that references an agent/team no longer present in the fetched roster
// (deleted or scoped out) instead of leaking a raw `agent:<id>` value.
export type AgentView = Pick<EmployeeAgent, "displayName" | "profileImageUrl" | "executorKind" | "enabled" | "availability">;
export type TeamView = Pick<AgentTeam, "name" | "profileImageUrl" | "members" | "lead" | "enabled">;

// Status is carried by the glyph's corner pip (the designed agent-state
// indicator), never by a text label. Map availability onto the shared
// `.agent-state` tone classes so agents and teams read the same status
// language as the backlog/routine boards.
export function availabilityTone(availability: LogicalAgentAvailability): "tone-good" | "tone-info" | "tone-warn" | "tone-bad" {
  if (availability === "ready") return "tone-good";
  if (availability === "busy") return "tone-info";
  if (availability === "offline") return "tone-bad";
  return "tone-warn";
}

export function effectiveAgentAvailability(agent: Pick<EmployeeAgent, "enabled" | "availability">): LogicalAgentAvailability {
  return agent.enabled ? agent.availability : "offline";
}

// Team identity chip — the same `.agent-state` box the boards draw, so the
// menu, the closed trigger, and the task cards all show one mark. The tone
// pip carries readiness; the glyph stays neutral.
function TeamMark({ team }: { team: TeamView }) {
  const { t } = useTranslation();
  const availability = teamAvailability(team);
  const stateLabel = `${team.name} · ${t(`status.${availability}`, { defaultValue: availability })}`;
  return (
    <span className={cn("agent-state", availabilityTone(availability))} role="img" aria-label={stateLabel} title={stateLabel}>
      <ProfileImage src={team.profileImageUrl} alt="" fallback={<IdentityMark kind="team" />} />
    </span>
  );
}

function AssignmentOption({ agent, team }: { agent?: AgentView; team?: TeamView }) {
  const { t } = useTranslation();
  if (agent) {
    const availability = effectiveAgentAvailability(agent);
    return (
      <span className="task-assignment-option">
        <AgentStateBadge
          agent={agent.executorKind}
          ready={availability === "ready"}
          availability={availability}
          imageUrl={agent.profileImageUrl}
          name={agent.displayName}
        />
        <span className="task-assignment-option-copy">
          <span>{agent.displayName}</span>
          <span>{agent.executorKind}</span>
        </span>
      </span>
    );
  }

  if (!team) return null;
  return (
    <span className="task-assignment-option">
      <TeamMark team={team} />
      <span className="task-assignment-option-copy">
        <span>{team.name}</span>
        <span>{t("backlog.team_member_count", { count: team.members.length })}</span>
      </span>
    </span>
  );
}

// The closed trigger carries identity only — mark + name on one line, at the
// same height and weight as every other select in the drawer. The summary
// card below owns the operational readout (descriptor, roster, readiness
// hint), so the two no longer repeat each other.
function AssignmentTriggerValue({ agent, team }: { agent?: AgentView; team?: TeamView }) {
  if (team) {
    return (
      <span className="task-assignment-trigger">
        <TeamMark team={team} />
        <span className="task-assignment-trigger-name">{team.name}</span>
      </span>
    );
  }
  if (agent) {
    const availability = effectiveAgentAvailability(agent);
    return (
      <span className="task-assignment-trigger">
        <AgentStateBadge
          agent={agent.executorKind}
          ready={availability === "ready"}
          availability={availability}
          imageUrl={agent.profileImageUrl}
          name={agent.displayName}
        />
        <span className="task-assignment-trigger-name">{agent.displayName}</span>
      </span>
    );
  }
  return null;
}

function EmptyOption({ value, label, disabled = false }: { value: string; label: string; disabled?: boolean }) {
  return (
    <SelectItem value={value} label={label} disabled={disabled}>
      <span className="task-assignment-option is-empty">
        <span className="agent-state agent-state--empty" aria-hidden="true" />
        <span className="task-assignment-option-copy">
          <span>{label}</span>
        </span>
      </span>
    </SelectItem>
  );
}

function ActionOption({ value, label, icon }: { value: string; label: string; icon: ReactNode }) {
  return (
    <SelectItem value={value} label={label}>
      <span className="task-assignment-option is-action">
        <span className="agent-state agent-state--empty" aria-hidden="true">{icon}</span>
        <span className="task-assignment-option-copy">
          <span>{label}</span>
        </span>
      </span>
    </SelectItem>
  );
}

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
 * The one agent/team picker every drawer uses.
 *
 * Agents and agent teams are two ROSTERS, not two sections of one list: they
 * are chosen for different reasons and a drawer that stacks them into a single
 * scroll makes the shorter roster disappear under the longer one. So the popup
 * is tabbed — one tab per roster — and the tab strip replaces the group labels
 * the list used to carry.
 *
 * The strip is chrome, not options, so it renders through `SelectContent`'s
 * `header` slot: inside the popup, outside `Select.List` (the `role="listbox"`,
 * which may only contain options). That also decides the keyboard contract —
 * focus stays on the listbox the whole time, so the tabs are not in the tab
 * order and ←/→ switch rosters while ↑/↓ walk the active one. Capture phase,
 * because the listbox's composite handler claims arrow keys first.
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
  const [tab, setTab] = useState<AssignmentTab>(selectedTab);

  const tabs: { id: AssignmentTab; label: string; count: number }[] = [
    { id: "agents", label: t("backlog.agents_section"), count: agents.length },
    { id: "teams", label: t("backlog.teams_section"), count: teams.length },
  ];

  function handleRosterKeys(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    event.stopPropagation();
    setTab(event.key === "ArrowRight" ? "teams" : "agents");
  }

  return (
    <Select
      value={value}
      // The popup always opens on the roster the current assignment came from,
      // so the checked row is the one on screen.
      onOpenChange={(open) => {
        if (open) setTab(selectedTab);
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
            if (selectedTeam) return <AssignmentTriggerValue team={selectedTeam} />;
            if (selectedAgent) return <AssignmentTriggerValue agent={selectedAgent} />;
            return t("backlog.assign_later");
          }}
        </SelectValue>
      </SelectTrigger>
      <SelectContent
        alignItemWithTrigger={false}
        onKeyDownCapture={handleRosterKeys}
        header={
          <div className="task-assignment-tabs" role="tablist" aria-label={t("backlog.assignment_label")}>
            {tabs.map((entry) => (
              <button
                key={entry.id}
                type="button"
                role="tab"
                tabIndex={-1}
                aria-selected={tab === entry.id}
                className="task-assignment-tab"
                // Keep focus on the listbox: a focus move out of it closes the
                // popup before the click lands.
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => setTab(entry.id)}
              >
                <span>{entry.label}</span>
                <span className="task-assignment-tab-count">{entry.count}</span>
              </button>
            ))}
          </div>
        }
      >
        {/* One group so the rows keep the popup's inner padding, named by the
            active tab so a reader hears which roster it just moved into. */}
        <SelectGroup aria-label={tabs.find((entry) => entry.id === tab)?.label}>
          <EmptyOption value={NO_ASSIGNMENT} label={t("backlog.assign_later")} />
          {tab === "agents" ? (
            <>
              {agents.map((agent) => (
                <SelectItem key={agent.id} value={`agent:${agent.id}`} label={`${agent.displayName} · ${agent.executorKind}`}>
                  <AssignmentOption agent={agent} />
                </SelectItem>
              ))}
              {agents.length === 0 ? (
                <EmptyOption value="__empty_agents__" label={t("backlog.no_agents_available")} disabled />
              ) : null}
              <ActionOption value={NAV_AGENTS} label={t("backlog.manage_agents")} icon={<NavAgents size={ICON.sm} />} />
            </>
          ) : (
            <>
              {teams.map((team) => (
                <SelectItem key={team.id} value={`team:${team.id}`} label={team.name}>
                  <AssignmentOption team={team} />
                </SelectItem>
              ))}
              {teams.length === 0 ? (
                <EmptyOption value="__empty_teams__" label={t("backlog.no_teams_available")} disabled />
              ) : null}
              <ActionOption value={NAV_TEAMS} label={t("backlog.create_team")} icon={<NavTeams size={ICON.sm} />} />
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
