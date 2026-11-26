"use client";

import type { ComponentProps, ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { SelectItem } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import type { AgentTeam, UserAgent, LogicalAgentAvailability } from "../../types";
import { agentModel } from "../../lib/agentModels";
import { teamAvailability } from "../../lib/taskAssignment";
import { AgentStateBadge } from "../AgentStateBadge";
import { IdentityMark } from "../IdentityMark";
import { ProfileImage } from "../ProfileImagePicker";
import { runtimeLabel } from "../../lib/runtimeLabel";
import { agentRoleLabel, type AgentRoleIdentity } from "../../lib/agentRoleLabel";

/* The rows every roster picker draws: one identity line per agent or team,
   plus the non-entity rows (empty slot, disabled empty roster, nav action)
   that sit among them. Shared so the task drawer, the project member drawer,
   the team-lead field, and the admin channel form cannot drift into four
   spellings of "an agent". */

// The pickers only read a handful of fields off an agent/team, so accept a
// narrowed view. This lets a caller synthesize a placeholder for a value that
// references an agent/team no longer present in the fetched roster (deleted or
// scoped out) instead of leaking a raw `agent:<id>` value.
export type AgentView = Pick<UserAgent, "displayName" | "profileImageUrl" | "executorKind" | "enabled" | "availability">
  & AgentRoleIdentity & Partial<Pick<UserAgent, "modelPolicy">>;
export type TeamView = Pick<AgentTeam, "name" | "profileImageUrl" | "members" | "lead" | "enabled" | "workflowSteps" | "workflowStepCount">;

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

export function effectiveAgentAvailability(agent: Pick<UserAgent, "enabled" | "availability">): LogicalAgentAvailability {
  return agent.enabled ? agent.availability : "offline";
}

/** An agent's visual badge — profile image (or monogram) with the readiness
 *  pip. Every surface that offers an agent to pick draws this, so a checklist,
 *  a filter menu, and a select all show the same face. */
export function RosterAgentMark({ agent }: { agent: AgentView }) {
  const availability = effectiveAgentAvailability(agent);
  return (
    <AgentStateBadge
      agent={agent.executorKind}
      ready={availability === "ready"}
      availability={availability}
      imageUrl={agent.profileImageUrl}
      name={agent.displayName}
    />
  );
}

// Team identity chip — the same `.agent-state` box the boards draw, so the
// menu, the closed trigger, and the task cards all show one mark. The tone
// pip carries readiness; the glyph stays neutral.
export function RosterTeamMark({ team }: { team: TeamView }) {
  const { t } = useTranslation();
  const availability = teamAvailability(team);
  const stateLabel = `${team.name} · ${t(`status.${availability}`, { defaultValue: availability })}`;
  return (
    <span className={cn("agent-state", availabilityTone(availability))} role="img" aria-label={stateLabel} title={stateLabel}>
      <ProfileImage src={team.profileImageUrl} alt="" fallback={<IdentityMark kind="team" />} />
    </span>
  );
}

/** Agent CLI names are a fixed ASCII enum ("claude", "codex") rendered as the
 *  product names they are. This used to be `text-transform: capitalize` in
 *  roster-select.css, but that selector also caught the translated team
 *  member-count line and the empty-option label — copy that must NOT be
 *  title-cased, and would be wrong to title-case in German or French. Doing it
 *  here keeps it on the one string that is a proper noun. */
const executorLabel = runtimeLabel;

/** One roster row: mark, name, and the one-line descriptor under it. */
export function RosterOption({ agent, team }: { agent?: AgentView; team?: TeamView }) {
  const { t } = useTranslation();
  if (agent) {
    const model = agentModel(agent);
    const role = agentRoleLabel(agent, t);
    return (
      <span className="roster-option">
        <RosterAgentMark agent={agent} />
        <span className="roster-option-copy">
          <span translate="no">{agent.displayName}</span>
          <span>
            {role ? <>{role}{" · "}</> : null}
            <span translate="no">{executorLabel(agent.executorKind)}</span>
            {" · "}
            {model ? <span translate="no">{model}</span> : t("agents_page.model_default")}
          </span>
        </span>
      </span>
    );
  }

  if (!team) return null;
  const stepCount = team.workflowStepCount ?? team.workflowSteps?.length;
  return (
    <span className="roster-option">
      <RosterTeamMark team={team} />
      <span className="roster-option-copy">
        <span translate="no">{team.name}</span>
        {/* A workflow Team is told apart by its steps: the members alone
            would read like any other Team. */}
        <span>{stepCount
          ? t("workflow.step_count", { count: stepCount })
          : t("backlog.team_member_count", { count: team.members.length })}</span>
      </span>
    </span>
  );
}

/** A roster entry as a ready-made option — the row plus the typeahead label a
 *  select needs, so no call site re-derives that label. The value stays the
 *  caller's: a surface that picks an agent by id and one that stores an
 *  `agent:<id>` assignment both select the same row. Remaining SelectItem
 *  props (disabled, className, data-*) pass straight through, and a surface
 *  that shows more than the identity row — the composer spells out why a
 *  target cannot take the thread — supplies its own children. */
type RosterItemProps = Omit<ComponentProps<typeof SelectItem>, "value" | "label">;

export function RosterAgentItem({ value, agent, children, ...itemProps }: { value: string; agent: AgentView } & RosterItemProps) {
  const { t } = useTranslation();
  const role = agentRoleLabel(agent, t);
  return (
    <SelectItem value={value} label={[agent.displayName, role, agent.executorKind].filter(Boolean).join(" · ")} {...itemProps}>
      {children ?? <RosterOption agent={agent} />}
    </SelectItem>
  );
}

export function RosterTeamItem({ value, team, children, ...itemProps }: { value: string; team: TeamView } & RosterItemProps) {
  return (
    <SelectItem value={value} label={team.name} {...itemProps}>
      {children ?? <RosterOption team={team} />}
    </SelectItem>
  );
}

/** The closed trigger carries identity only — mark, name and role, at the
 *  same height and weight as every other select in the drawer. Any operational
 *  readout belongs outside the trigger, so the two never repeat each other.
 *  `hideBusyPulse` silences the busy corner pip for a surface that already
 *  announces the same activity next to the trigger (the composer's running
 *  rail), so the two pulses don't repeat each other. */
export function RosterTriggerValue({ agent, team, hideBusyPulse = false }: { agent?: AgentView; team?: TeamView; hideBusyPulse?: boolean }) {
  const { t } = useTranslation();
  if (team) {
    return (
      <span className="roster-trigger">
        <RosterTeamMark team={team} />
        <span className="roster-trigger-name" translate="no" title={team.name}>{team.name}</span>
      </span>
    );
  }
  if (agent) {
    const role = agentRoleLabel(agent, t);
    return (
      <span className={cn("roster-trigger", hideBusyPulse && "roster-trigger--no-busy-pulse")}>
        <RosterAgentMark agent={agent} />
        <span className="agent-identity-copy" title={role ? `${agent.displayName} · ${role}` : agent.displayName}>
          <span className="roster-trigger-name" translate="no" data-agent-name>{agent.displayName}</span>
          {role ? <span className="agent-role-label">{role}</span> : null}
        </span>
      </span>
    );
  }
  return null;
}

/** A row with no entity behind it: the unassigned slot, or an empty roster's
 *  own explanation (disabled) instead of a silently missing tab. */
export function RosterEmptyOption({ value, label, disabled = false }: { value: string; label: string; disabled?: boolean }) {
  return (
    <SelectItem value={value} label={label} disabled={disabled}>
      <span className="roster-option is-empty">
        <span className="agent-state agent-state--empty" aria-hidden="true" />
        <span className="roster-option-copy">
          <span>{label}</span>
        </span>
      </span>
    </SelectItem>
  );
}

/** A row that navigates instead of selecting — "Manage agents", "New team". */
export function RosterActionOption({ value, label, icon }: { value: string; label: string; icon: ReactNode }) {
  return (
    <SelectItem value={value} label={label}>
      <span className="roster-option is-action">
        <span className="agent-state agent-state--empty" aria-hidden="true">{icon}</span>
        <span className="roster-option-copy">
          <span>{label}</span>
        </span>
      </span>
    </SelectItem>
  );
}
