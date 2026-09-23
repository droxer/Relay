"use client";

import { useId } from "react";
import { useTranslation } from "react-i18next";
import type { AgentName, LogicalAgentAvailability, TeamMemberConfig } from "../types";
import { agentLabel } from "../lib/plan";
import { AgentStateBadge } from "./AgentStateBadge";
import { TonePill } from "./StatusPill";
import { Checkbox } from "@/components/ui/checkbox";
import { Field } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

const ROLES = ["inherit", "planner", "implementer", "tester", "reviewer", "fixer"] as const;

/* The per-member work contract editor, shared by the admin TeamDrawer and the
   team workspace profile. Every control is a <Field> so the label voice matches
   the `teams.members` / `teams.lead` fields these sit between — a bare <label>
   renders at body type and breaks that run. The flags are the <Checkbox>
   primitive for the same reason TeamMemberOption uses it: a native checkbox is
   OS chrome with no theme and no shared focus ring.

   Each member is a card with the same charter grammar as the project crew
   tiles — who they are (avatar, name, runtime · effective role) in the head,
   what they own in the body — and a labelled group, so the member's name
   actually scopes its controls for a screen reader. */
export function TeamResponsibilities({ members, leadId, configs, criteria, onConfigs, onCriteria, disabled }: {
  members: Array<{
    id: string;
    displayName: string;
    executorKind: AgentName;
    profileImageUrl?: string | null;
    enabled?: boolean;
    availability?: LogicalAgentAvailability;
    defaultRole?: string;
  }>;
  leadId: string;
  configs: Record<string, TeamMemberConfig>;
  criteria: string[];
  onConfigs: (value: Record<string, TeamMemberConfig>) => void;
  onCriteria: (value: string[]) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const id = useId();
  const update = (agentId: string, patch: Partial<TeamMemberConfig>) =>
    onConfigs({ ...configs, [agentId]: { ...configs[agentId], ...patch } });

  return (
    <fieldset className="team-work-fieldset" disabled={disabled}>
      <legend>{t("team_work.responsibilities")}</legend>
      <p className="team-work-help">{t("team_work.help")}</p>
      {members.length === 0 ? (
        <span className="adm-form-hint">{t("teams.no_agents")}</span>
      ) : null}
      {members.length ? (
      <div className="team-work-members">
        {members.map((member) => {
          const config = configs[member.id] ?? {};
          const base = `${id}-${member.id}`;
          const onRequest = config.participation === "on_request";
          const effectiveRole = config.role ?? member.defaultRole;
          const availability = member.enabled === false ? "offline" : member.availability;
          const requiredByDefault = !onRequest
            && ["tester", "reviewer"].includes(effectiveRole ?? "");
          return (
            <article className="team-work-member" key={member.id} role="group" aria-labelledby={`${base}-name`}>
              <header className="team-work-member-head">
                <AgentStateBadge
                  agent={member.executorKind}
                  ready={availability === "ready"}
                  availability={availability}
                  imageUrl={member.profileImageUrl}
                  name={member.displayName}
                />
                <span className="team-work-member-identity">
                  <span className="team-work-member-name">
                    <strong id={`${base}-name`}>{member.displayName}</strong>
                    {member.id === leadId ? <TonePill tone="info" label={t("project.lead_badge")} /> : null}
                  </span>
                  {/* Runtime · the role the member will actually play, so an
                      inherited role is visible without opening the select. */}
                  <span className="team-work-member-meta">
                    {agentLabel(member.executorKind)}
                    {effectiveRole ? ` · ${t(`team_work.role_${effectiveRole}`)}` : null}
                  </span>
                </span>
              </header>
              <Field label={t("team_work.role")} labelId={`${base}-role`} wrapper="div">
                <Select
                  value={config.role ?? "inherit"}
                  disabled={disabled}
                  onValueChange={(value) => {
                    if (value) {
                      update(member.id, {
                        role: value === "inherit" ? undefined : (value as TeamMemberConfig["role"]),
                      });
                    }
                  }}
                >
                  <SelectTrigger className="w-full" aria-labelledby={`${base}-role`}>
                    {/* Bare <SelectValue/> renders the stored value, so the
                        trigger read "inherit" / "implementer" instead of the
                        role's copy. The render function is the seam the lead
                        select already uses. */}
                    <SelectValue>{(value: string) => t(`team_work.role_${value}`)}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {ROLES.map((role) => (
                      <SelectItem key={role} value={role}>{t(`team_work.role_${role}`)}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field label={t("team_work.responsibility")}>
                <Textarea
                  rows={2}
                  value={config.responsibility ?? ""}
                  maxLength={4000}
                  placeholder={t("team_work.scope_example")}
                  onChange={(event) => update(member.id, { responsibility: event.target.value })}
                />
              </Field>
              <Field label={t("team_work.outputs")} hint={t("team_work.one_per_line")}>
                <Textarea
                  rows={2}
                  value={(config.expectedOutputs ?? []).join("\n")}
                  onChange={(event) => update(member.id, { expectedOutputs: event.target.value.split("\n") })}
                />
              </Field>
              {/* The wrapping <label> is the whole accessible name on these
                  flags: base-ui already points the control's aria-labelledby
                  at it, so an aria-label repeating the same copy gets
                  concatenated and the flag announces twice. */}
              {member.id !== leadId ? (
                <div className="team-work-flags">
                  <label className="team-work-flag">
                    <Checkbox
                      checked={onRequest}
                      disabled={disabled}
                      onCheckedChange={(value) => update(member.id, {
                        participation: value === true ? "on_request" : "always",
                        // Clearing it (rather than pinning false) hands the row
                        // back to the role default when the flag is unset.
                        required: value === true ? false : undefined,
                      })}
                    />
                    <span>{t("team_work.on_request")}</span>
                  </label>
                  <label className="team-work-flag">
                    <Checkbox
                      checked={config.required ?? requiredByDefault}
                      disabled={onRequest || disabled}
                      onCheckedChange={(value) => update(member.id, { required: value === true })}
                    />
                    <span>{t("team_work.required")}</span>
                  </label>
                </div>
              ) : null}
            </article>
          );
        })}
      </div>
      ) : null}
      <Field label={t("team_work.criteria")} hint={t("team_work.one_per_line")}>
        <Textarea
          rows={3}
          value={criteria.join("\n")}
          onChange={(event) => onCriteria(event.target.value.split("\n"))}
        />
      </Field>
    </fieldset>
  );
}
