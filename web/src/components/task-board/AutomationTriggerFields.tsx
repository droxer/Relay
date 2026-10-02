"use client";

import { useId } from "react";
import { useTranslation } from "react-i18next";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { TITLE_CONTAINS_MAX, TRIGGER_KINDS, TRIGGER_ON, isEventKind, triggerError, triggerForKind } from "../../lib/automationTrigger";
import { TASK_PRIORITIES, TASK_STATUSES } from "../../lib/backlog";
import type { AgentTeam, EmployeeAgent, ProjectRecord, RoutineTrigger, RoutineTriggerFilters, RoutineTriggerKind, RoutineTriggerOn } from "../../types";

const ANY = "__any__";

type Props = {
  trigger: RoutineTrigger;
  agents: EmployeeAgent[];
  teams: AgentTeam[];
  projects: ProjectRecord[];
  onChange: (next: RoutineTrigger) => void;
};

export function TriggerKindField({ trigger, onChange }: Pick<Props, "trigger" | "onChange">) {
  const { t } = useTranslation();
  const labelId = useId();
  return (
    <Field label={t("automation.trigger")} labelId={labelId} wrapper="div">
      <Select value={trigger.kind} onValueChange={(value) => value && onChange(triggerForKind(value as RoutineTriggerKind))}>
        <SelectTrigger className="w-full" aria-labelledby={labelId}>
          <SelectValue>{(value: RoutineTriggerKind) => t(`automation.kinds.${value}`)}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {TRIGGER_KINDS.map((kind) => (
            <SelectItem key={kind} value={kind} label={t(`automation.kinds.${kind}`)}>{t(`automation.kinds.${kind}`)}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  );
}

export function EventTriggerFields({ trigger, agents, teams, projects, onChange }: Props) {
  const { t } = useTranslation();
  const onId = useId();
  const errorId = useId();
  const titleLabelId = useId();
  if (!isEventKind(trigger.kind)) return null;
  const filters = trigger.filters ?? {};
  const setFilter = (key: keyof RoutineTriggerFilters, value: string) =>
    onChange({ ...trigger, filters: { ...filters, [key]: value === ANY ? undefined : value } });
  const choice = (key: keyof RoutineTriggerFilters, label: string, options: Array<{ value: string; label: string }>) => (
    <FilterSelect key={key} label={label} value={(filters[key] as string | undefined) ?? ANY}
      options={[{ value: ANY, label: t("automation.filter_any") }, ...options]} onChange={(value) => setFilter(key, value)} />
  );
  const error = triggerError(trigger);
  return (
    <>
      <Field label={t("automation.on")} labelId={onId} wrapper="div">
        <Select value={trigger.on} onValueChange={(value) => value && onChange({ ...trigger, on: value as RoutineTriggerOn })}>
          <SelectTrigger className="w-full" aria-labelledby={onId}>
            <SelectValue>{(value: RoutineTriggerOn) => t(`automation.on_values.${value}`)}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {TRIGGER_ON[trigger.kind].map((on) => (
              <SelectItem key={on} value={on} label={t(`automation.on_values.${on}`)}>{t(`automation.on_values.${on}`)}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      {choice("projectId", t("automation.filter_project"), projects.map((p) => ({ value: p.id, label: p.name })))}
      {choice("assignedAgentId", t("automation.filter_agent"), agents.map((a) => ({ value: a.id, label: a.displayName })))}
      {choice("assignedTeamId", t("automation.filter_team"), teams.map((team) => ({ value: team.id, label: team.name })))}
      {trigger.on === "status_changed" ? (
        <>
          {choice("fromStatus", t("automation.filter_from_status"), TASK_STATUSES.map((s) => ({ value: s, label: t(`backlog.statuses.${s}`) })))}
          {choice("toStatus", t("automation.filter_to_status"), TASK_STATUSES.map((s) => ({ value: s, label: t(`backlog.statuses.${s}`) })))}
        </>
      ) : null}
      {choice("priority", t("automation.filter_priority"), TASK_PRIORITIES.map((p) => ({ value: p, label: t(`backlog.priorities.${p}`) })))}
      <Field label={t("automation.filter_title")} labelId={titleLabelId} error={error ? t(error) : undefined} errorId={errorId}>
        <Input name="automation-title-contains" maxLength={TITLE_CONTAINS_MAX + 20}
          aria-labelledby={titleLabelId} aria-invalid={Boolean(error) || undefined} aria-describedby={error ? errorId : undefined}
          value={filters.titleContains ?? ""} onChange={(event) => setFilter("titleContains", event.target.value)} />
      </Field>
    </>
  );
}

function FilterSelect({ label, value, options, onChange }: {
  label: string; value: string; options: Array<{ value: string; label: string }>; onChange: (value: string) => void;
}) {
  const labelId = useId();
  const labels = new Map(options.map((option) => [option.value, option.label]));
  return (
    <Field label={label} labelId={labelId} wrapper="div">
      <Select value={value} onValueChange={(next) => next && onChange(next)}>
        <SelectTrigger className="w-full" aria-labelledby={labelId}>
          <SelectValue>{(current: string) => labels.get(current) ?? current}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value} label={option.label}>{option.label}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  );
}
