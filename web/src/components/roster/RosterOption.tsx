"use client";

import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { SelectItem } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import type { AgentTeam, EmployeeAgent, LogicalAgentAvailability } from "../../types";
import { teamAvailability } from "../../lib/taskAssignment";
import { AgentStateBadge } from "../AgentStateBadge";
import { IdentityMark } from "../IdentityMark";
import { ProfileImage } from "../ProfileImagePicker";

/* The rows every roster picker draws: one identity line per agent or team,
   plus the non-entity rows (empty slot, disabled empty roster, nav action)
   that sit among them. Shared so the task drawer, the project member drawer,
   the team-lead field, and the admin channel form cannot drift into four
   spellings of "an agent". */

// The pickers only read a handful of fields off an agent/team, so accept a
// narrowed view. This lets a caller synthesize a placeholder for a value that
// references an agent/team no longer present in the fetched roster (deleted or
// scoped out) instead of leaking a raw `agent:<id>` value.
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
export function TeamMark({ team }: { team: TeamView }) {
  const { t } = useTranslation();
  const availability = teamAvailability(team);
  const stateLabel = `${team.name} · ${t(`status.${availability}`, { defaultValue: availability })}`;
  return (
    <span className={cn("agent-state", availabilityTone(availability))} role="img" aria-label={stateLabel} title={stateLabel}>
      <ProfileImage src={team.profileImageUrl} alt="" fallback={<IdentityMark kind="team" />} />
    </span>
  );
}

/** One roster row: mark, name, and the one-line descriptor under it. */
export function RosterOption({ agent, team }: { agent?: AgentView; team?: TeamView }) {
  const { t } = useTranslation();
  if (agent) {
    const availability = effectiveAgentAvailability(agent);
    return (
      <span className="roster-option">
        <AgentStateBadge
          agent={agent.executorKind}
          ready={availability === "ready"}
          availability={availability}
          imageUrl={agent.profileImageUrl}
          name={agent.displayName}
        />
        <span className="roster-option-copy">
          <span>{agent.displayName}</span>
          <span>{agent.executorKind}</span>
        </span>
      </span>
    );
  }

  if (!team) return null;
  return (
    <span className="roster-option">
      <TeamMark team={team} />
      <span className="roster-option-copy">
        <span>{team.name}</span>
        <span>{t("backlog.team_member_count", { count: team.members.length })}</span>
      </span>
    </span>
  );
}

/** A roster entry as a ready-made option — the row plus the typeahead label a
 *  select needs, so no call site re-derives that label. The value stays the
 *  caller's: a surface that picks an agent by id and one that stores an
 *  `agent:<id>` assignment both select the same row. */
export function RosterAgentItem({ value, agent }: { value: string; agent: AgentView }) {
  return (
    <SelectItem value={value} label={`${agent.displayName} · ${agent.executorKind}`}>
      <RosterOption agent={agent} />
    </SelectItem>
  );
}

export function RosterTeamItem({ value, team }: { value: string; team: TeamView }) {
  return (
    <SelectItem value={value} label={team.name}>
      <RosterOption team={team} />
    </SelectItem>
  );
}

/** The closed trigger carries identity only — mark + name on one line, at the
 *  same height and weight as every other select in the drawer. Any operational
 *  readout belongs outside the trigger, so the two never repeat each other. */
export function RosterTriggerValue({ agent, team }: { agent?: AgentView; team?: TeamView }) {
  if (team) {
    return (
      <span className="roster-trigger">
        <TeamMark team={team} />
        <span className="roster-trigger-name">{team.name}</span>
      </span>
    );
  }
  if (agent) {
    const availability = effectiveAgentAvailability(agent);
    return (
      <span className="roster-trigger">
        <AgentStateBadge
          agent={agent.executorKind}
          ready={availability === "ready"}
          availability={availability}
          imageUrl={agent.profileImageUrl}
          name={agent.displayName}
        />
        <span className="roster-trigger-name">{agent.displayName}</span>
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
