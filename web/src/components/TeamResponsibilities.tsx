"use client";

import { useId } from "react";
import { useTranslation } from "react-i18next";
import type { TeamMemberConfig } from "../types";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";

export function TeamResponsibilities({ members, leadId, configs, criteria, onConfigs, onCriteria, disabled }: {
  members: Array<{ id: string; displayName: string; defaultRole?: string }>;
  leadId: string;
  configs: Record<string, TeamMemberConfig>;
  criteria: string[];
  onConfigs: (value: Record<string, TeamMemberConfig>) => void;
  onCriteria: (value: string[]) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const id = useId();
  const update = (agentId: string, patch: Partial<TeamMemberConfig>) => onConfigs({ ...configs, [agentId]: { ...configs[agentId], ...patch } });
  return <fieldset className="team-member-fieldset" disabled={disabled}>
    <legend>{t("team_work.responsibilities")}</legend>
    <p className="adm-form-hint">{t("team_work.help")}</p>
    {members.map(member => {
      const config = configs[member.id] ?? {};
      const base = `${id}-${member.id}`;
      return <div className="grid gap-3 py-3" key={member.id}>
        <strong>{member.displayName}{member.id === leadId ? ` · ${t("teams.lead")}` : ""}</strong>
        <label id={`${base}-role`}>{t("team_work.role")}</label>
        <Select value={config.role ?? "inherit"} disabled={disabled} onValueChange={value => {
          if (value) update(member.id, { role: value === "inherit" ? undefined : value as TeamMemberConfig["role"] });
        }}>
          <SelectTrigger aria-labelledby={`${base}-role`}><SelectValue /></SelectTrigger>
          <SelectContent>{["inherit", "planner", "implementer", "tester", "reviewer", "fixer"].map(role =>
            <SelectItem key={role} value={role}>{t(`team_work.role_${role}`)}</SelectItem>)}</SelectContent>
        </Select>
        <label htmlFor={`${base}-scope`}>{t("team_work.responsibility")}</label>
        <Input id={`${base}-scope`} value={config.responsibility ?? ""} maxLength={4000}
          placeholder={t("team_work.scope_example")} onChange={event => update(member.id, { responsibility: event.target.value })} />
        <label htmlFor={`${base}-outputs`}>{t("team_work.outputs")}</label>
        <Textarea id={`${base}-outputs`} rows={2} value={(config.expectedOutputs ?? []).join("\n")}
          onChange={event => update(member.id, { expectedOutputs: event.target.value.split("\n") })} />
        {member.id !== leadId ? <div className="flex flex-wrap gap-4">
          <label className="flex items-center gap-2"><input type="checkbox" checked={config.participation === "on_request"}
            onChange={event => update(member.id, { participation: event.target.checked ? "on_request" : "always", ...(event.target.checked ? { required: false } : {}) })} />{t("team_work.on_request")}</label>
          <label className="flex items-center gap-2"><input type="checkbox" checked={config.required ?? (config.participation !== "on_request" && ["tester", "reviewer"].includes(config.role ?? member.defaultRole ?? ""))}
            disabled={config.participation === "on_request" || disabled}
            onChange={event => update(member.id, { required: event.target.checked })} />{t("team_work.required")}</label>
        </div> : null}
      </div>;
    })}
    <label htmlFor={`${id}-criteria`}>{t("team_work.criteria")}</label>
    <Textarea id={`${id}-criteria`} rows={3} value={criteria.join("\n")} onChange={event => onCriteria(event.target.value.split("\n"))} />
  </fieldset>;
}
