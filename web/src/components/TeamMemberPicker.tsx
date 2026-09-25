"use client";

import { forwardRef, useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { EmployeeAgent } from "../types";
import { AgentMetaLine } from "./AgentMetaLine";
import { AgentStateBadge } from "./AgentStateBadge";
import { TonePill } from "./StatusPill";
import { ActionAdd, ActionRemove, ICON } from "./icons";
import { Button } from "@/components/ui/button";
import { FieldError } from "@/components/ui/field";
import { Select, SelectContent, SelectGroup, SelectTrigger, SelectValue } from "@/components/ui/select";
import { RosterAgentItem, effectiveAgentAvailability } from "./roster/RosterOption";
import { rosterLabel, useRosterTabs, type RosterTab } from "./roster/RosterTabs";

export type TeamMembership = { memberIds: string[]; leadId: string };

/** Add appends; the first member picked becomes the lead. */
export function addTeamMember(current: TeamMembership, agentId: string): TeamMembership {
  if (current.memberIds.includes(agentId)) return current;
  return {
    memberIds: [...current.memberIds, agentId],
    leadId: current.leadId || agentId,
  };
}

/** Removing the lead hands the role to the next member in order. */
export function removeTeamMember(current: TeamMembership, agentId: string): TeamMembership {
  const memberIds = current.memberIds.filter((id) => id !== agentId);
  return {
    memberIds,
    leadId: current.leadId === agentId ? (memberIds[0] ?? "") : current.leadId,
  };
}

/* The team's crew as a short list — only the agents actually on the team,
   each with its lead marker and a remove control — plus one "Add member"
   roster picker for everyone else. It replaces a checkbox row for every agent
   the employee owns and a separate lead select that restated the same list:
   the lead is chosen on the row it applies to, and the list never grows past
   the team itself. */
export const TeamMemberPicker = forwardRef<HTMLFieldSetElement, {
  agents: EmployeeAgent[];
  value: TeamMembership;
  onChange: (next: TeamMembership) => void;
  disabled?: boolean;
  /** The team record already titles the section, so it keeps the legend for
   *  assistive tech only. */
  legendHidden?: boolean;
  error?: string;
  errorId?: string;
  /** Replaces the generic "no agents" line — team setup says why the list is
   *  empty (no computer picked yet, or nobody placed on it). */
  emptyHint?: string;
}>(function TeamMemberPicker({ agents, value, onChange, disabled = false, legendHidden = false, error, errorId, emptyHint }, ref) {
  const { t } = useTranslation();
  const members = useMemo(
    () => value.memberIds
      .map((id) => agents.find((agent) => agent.id === id))
      .filter((agent): agent is EmployeeAgent => Boolean(agent)),
    [agents, value.memberIds],
  );
  const candidates = useMemo(
    () => agents.filter((agent) => !value.memberIds.includes(agent.id)),
    [agents, value.memberIds],
  );
  // Only agents can join a team, so the shared picker draws no tab strip.
  const rosterTabs: RosterTab<"agents">[] = [
    { id: "agents", label: t("teams.add_member"), count: candidates.length },
  ];
  const roster = useRosterTabs({ tabs: rosterTabs, activeTab: "agents", label: t("teams.add_member") });

  return (
    <fieldset
      ref={ref}
      className="team-member-picker"
      tabIndex={-1}
      aria-invalid={error ? true : undefined}
      aria-describedby={error ? errorId : undefined}
    >
      <legend className={legendHidden ? "sr-only" : "team-member-picker-legend"}>
        {t("teams.members")}
        <span className="tnum">{members.length}</span>
      </legend>
      {members.length ? (
        <ul className="team-member-rows">
          {members.map((agent) => {
            const lead = agent.id === value.leadId;
            const availability = effectiveAgentAvailability(agent);
            return (
              <li key={agent.id} className="team-member-row">
                <AgentStateBadge
                  agent={agent.executorKind}
                  ready={availability === "ready"}
                  availability={availability}
                  imageUrl={agent.profileImageUrl}
                  name={agent.displayName}
                />
                <span className="team-member-row-main">
                  <span className="team-member-row-name" translate="no">{agent.displayName}</span>
                  <AgentMetaLine executorKind={agent.executorKind} placements={agent.placements} />
                </span>
                {lead ? (
                  <TonePill tone="info" label={t("project.lead_badge")} />
                ) : (
                  <Button
                    type="button"
                    variant="ghost"
                    size="dense"
                    className="team-member-row-lead"
                    aria-label={t("teams.make_lead_named", { name: agent.displayName })}
                    disabled={disabled}
                    onClick={() => onChange({ ...value, leadId: agent.id })}
                  >
                    {t("teams.make_lead")}
                  </Button>
                )}
                <Button
                  type="button"
                  variant="ghost"
                  className="team-member-row-remove"
                  tooltip={t("teams.remove_member", { name: agent.displayName })}
                  disabled={disabled}
                  onClick={() => onChange(removeTeamMember(value, agent.id))}
                >
                  <ActionRemove size={ICON.sm} aria-hidden="true" />
                </Button>
              </li>
            );
          })}
        </ul>
      ) : null}

      {agents.length === 0 ? (
        <span className="adm-form-hint">{emptyHint ?? t("teams.no_agents")}</span>
      ) : candidates.length ? (
        <Select
          value={null}
          disabled={disabled}
          onValueChange={(agentId) => {
            if (typeof agentId === "string") onChange(addTeamMember(value, agentId));
          }}
          onOpenChange={(open) => { if (open) roster.resetTab(); }}
        >
          <SelectTrigger className="team-member-add" aria-label={t("teams.add_member")}>
            <SelectValue placeholder={(
              <span className="team-member-add-label">
                <ActionAdd size={ICON.sm} aria-hidden="true" />
                {t("teams.add_member")}
              </span>
            )} />
          </SelectTrigger>
          <SelectContent
            alignItemWithTrigger={false}
            onKeyDownCapture={roster.onKeyDownCapture}
            header={roster.header}
          >
            <SelectGroup aria-label={rosterLabel(rosterTabs, roster.tab)}>
              {candidates.map((agent) => (
                <RosterAgentItem key={agent.id} value={agent.id} agent={agent} />
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      ) : (
        <span className="adm-form-hint">{t("teams.all_agents_added")}</span>
      )}

      {error ? <FieldError id={errorId}>{error}</FieldError> : null}
    </fieldset>
  );
});
