"use client";

import { useTranslation } from "react-i18next";
import type { TeamMemberConfig } from "../types";
import { TeamMemberEditCard, type TeamCardMember } from "./TeamMemberCard";
import { Field } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";

/* The team work-contract editor, shared by the admin TeamDrawer and the team
   workspace's full edit mode: one always-editable member card per member (see
   TeamMemberCard for the card anatomy), then the team's acceptance criteria. */
export function TeamResponsibilities({ members, leadId, configs, criteria, onConfigs, onCriteria, disabled }: {
  members: TeamCardMember[];
  leadId: string;
  configs: Record<string, TeamMemberConfig>;
  criteria: string[];
  onConfigs: (value: Record<string, TeamMemberConfig>) => void;
  onCriteria: (value: string[]) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();

  return (
    <fieldset className="team-work-fieldset" disabled={disabled}>
      <legend>{t("team_work.responsibilities")}</legend>
      <p className="team-work-help">{t("team_work.help")}</p>
      {members.length === 0 ? (
        <span className="adm-form-hint">{t("teams.no_agents")}</span>
      ) : null}
      {members.length ? (
      <div className="team-work-members">
        {members.map((member) => (
          <TeamMemberEditCard
            key={member.id}
            member={member}
            config={configs[member.id] ?? {}}
            lead={member.id === leadId}
            disabled={disabled}
            onChange={(next) => onConfigs({ ...configs, [member.id]: next })}
          />
        ))}
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
