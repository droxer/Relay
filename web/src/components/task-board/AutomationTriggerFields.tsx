"use client";

import { useId, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { ChoiceGroup } from "@/components/ui/choice-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { TITLE_CONTAINS_MAX, TRIGGER_KINDS, TRIGGER_ON, triggerError, triggerForKind } from "../../lib/automationTrigger";
import { TASK_PRIORITIES, TASK_STATUSES } from "../../lib/backlog";
import { RosterAgentMark, RosterTeamMark } from "../roster/RosterOption";
import type { AgentTeam, UserAgent, ProjectListItem, RoutineTrigger, RoutineTriggerFilters, RoutineTriggerKind, RoutineTriggerOn } from "../../types";

const ANY = "__any__";

type Props = {
  trigger: RoutineTrigger;
  agents: UserAgent[];
  teams: AgentTeam[];
  projects: ProjectListItem[];
  onChange: (next: RoutineTrigger) => void;
};

/** "Run now only" in the kind picker: an automation with no triggers. */
const NO_TRIGGER = "none";
type KindChoice = RoutineTriggerKind | typeof NO_TRIGGER;

/**
 * What starts the automation, for one trigger or none. `triggersEnabled`
 * false (the server's switch) leaves only Schedule and Run now only — plus
 * the kind already saved, so an existing trigger still reads as itself.
 */
export function TriggerKindField({ triggers, triggersEnabled = true, onChange }: {
  triggers: RoutineTrigger[];
  triggersEnabled?: boolean;
  onChange: (next: RoutineTrigger[]) => void;
}) {
  const { t } = useTranslation();
  const labelId = useId();
  const current = triggers[0]?.kind;
  const value: KindChoice = current ?? NO_TRIGGER;
  const kinds = TRIGGER_KINDS.filter((kind) => triggersEnabled || kind === "schedule" || kind === current);
  const options: KindChoice[] = [...kinds, NO_TRIGGER];
  const label = (choice: KindChoice) => t(`automation.kinds.${choice}`);
  /* Up to five short answers to "what starts it" — on screen at once, so the
     reader weighs Schedule against an event without opening a menu. It is the
     field every other one below depends on, so it spans the form. */
  return (
    <Field label={t("automation.trigger_kind")} labelId={labelId} wrapper="div" className="trigger-filters-wide">
      <ChoiceGroup<KindChoice>
        name="automation-trigger-kind"
        aria-labelledby={labelId}
        value={value}
        onValueChange={(next) => onChange(next === NO_TRIGGER ? [] : [triggerForKind(next)])}
        options={options.map((choice) => ({ value: choice, label: label(choice) }))}
      />
    </Field>
  );
}

export function EventTriggerFields({ trigger, agents, teams, projects, onChange }: Props) {
  const { t } = useTranslation();
  const onId = useId();
  const errorId = useId();
  const titleLabelId = useId();
  const filtersLabelId = useId();
  if (trigger.kind === "schedule" || trigger.kind === "webhook") return null;
  const filters = trigger.filters ?? {};
  const setFilter = (key: keyof RoutineTriggerFilters, value: string) =>
    onChange({ ...trigger, filters: { ...filters, [key]: value === ANY ? undefined : value } });
  const choice = (key: keyof RoutineTriggerFilters, label: string, options: FilterChoice[]) => (
    <FilterSelect key={key} label={label} value={(filters[key] as string | undefined) ?? ANY}
      options={[{ value: ANY, label: t("automation.filter_any") }, ...options]} onChange={(value) => setFilter(key, value)} />
  );
  const error = triggerError(trigger);
  return (
    <>
      <Field label={t("automation.on")} labelId={onId} wrapper="div" className="trigger-filters-wide">
        <ChoiceGroup<RoutineTriggerOn>
          name="automation-trigger-on"
          aria-labelledby={onId}
          value={trigger.on}
          onValueChange={(on) => onChange({ ...trigger, on })}
          options={TRIGGER_ON[trigger.kind].map((on) => ({ value: on, label: t(`automation.on_values.${on}`) }))}
        />
      </Field>
      {/* The filters narrow the event, so they read as one group under it
          rather than as nine peers of the trigger itself. A status change is
          mostly about its statuses, so those lead. */}
      <div className="trigger-filters" role="group" aria-labelledby={filtersLabelId}>
        <div className="trigger-filters-head">
          <span className="trigger-filters-title" id={filtersLabelId}>{t("automation.filters_legend")}</span>
          <span className="adm-form-hint">{t("automation.filters_hint")}</span>
        </div>
        <div className="task-drawer-form-grid">
          {trigger.on === "status_changed" ? (
            <>
              {choice("fromStatus", t("automation.filter_from_status"), TASK_STATUSES.map((s) => ({ value: s, label: t(`backlog.statuses.${s}`) })))}
              {choice("toStatus", t("automation.filter_to_status"), TASK_STATUSES.map((s) => ({ value: s, label: t(`backlog.statuses.${s}`) })))}
            </>
          ) : null}
          {choice("projectId", t("automation.filter_project"), projects.map((p) => ({ value: p.id, label: p.name })))}
          {choice("assignedAgentId", t("automation.filter_agent"), agents.map((a) => ({ value: a.id, label: a.displayName, mark: <RosterAgentMark agent={a} /> })))}
          {choice("assignedTeamId", t("automation.filter_team"), teams.map((team) => ({ value: team.id, label: team.name, mark: <RosterTeamMark team={team} /> })))}
          {/* Any + three priorities: a fixed set, so it reads as segments
              rather than a menu like the open-ended rosters above. */}
          <PriorityFilter value={filters.priority ?? ANY} onChange={(value) => setFilter("priority", value)} />
          <Field label={t("automation.filter_title")} labelId={titleLabelId} error={error ? t(error) : undefined} errorId={errorId}
            className="trigger-filters-wide">
            <Input name="automation-title-contains" maxLength={TITLE_CONTAINS_MAX + 20}
              aria-labelledby={titleLabelId} aria-invalid={Boolean(error) || undefined} aria-describedby={error ? errorId : undefined}
              value={filters.titleContains ?? ""} onChange={(event) => setFilter("titleContains", event.target.value)} />
          </Field>
        </div>
      </div>
    </>
  );
}

function PriorityFilter({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const { t } = useTranslation();
  const labelId = useId();
  return (
    <Field label={t("automation.filter_priority")} labelId={labelId} wrapper="div">
      <ChoiceGroup<string>
        name="automation-filter-priority"
        aria-labelledby={labelId}
        value={value}
        onValueChange={onChange}
        options={[
          { value: ANY, label: t("automation.filter_any") },
          ...TASK_PRIORITIES.map((priority) => ({ value: priority, label: t(`backlog.priorities.${priority}`) })),
        ]}
      />
    </Field>
  );
}

/** An agent or team choice carries its visual badge, in the menu and the trigger. */
type FilterChoice = { value: string; label: string; mark?: ReactNode };

/* In a list of badged choices, "Any" holds the empty slot so names align —
   the same placeholder the roster pickers draw for "Unassigned". */
function ChoiceLabel({ option, slotted }: { option: FilterChoice; slotted: boolean }) {
  if (!slotted) return <>{option.label}</>;
  return (
    <span className="roster-trigger">
      {option.mark ?? <span className="agent-state agent-state--empty" aria-hidden="true" />}
      <span className="roster-trigger-name" translate="no">{option.label}</span>
    </span>
  );
}

function FilterSelect({ label, value, options, onChange }: {
  label: string; value: string; options: FilterChoice[]; onChange: (value: string) => void;
}) {
  const labelId = useId();
  const byValue = new Map(options.map((option) => [option.value, option]));
  const slotted = options.some((option) => option.mark);
  return (
    <Field label={label} labelId={labelId} wrapper="div">
      <Select value={value} onValueChange={(next) => next && onChange(next)}>
        <SelectTrigger className="w-full" aria-labelledby={labelId}>
          <SelectValue>{(current: string) => {
            const option = byValue.get(current);
            return option ? <ChoiceLabel option={option} slotted={slotted} /> : current;
          }}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value} label={option.label}><ChoiceLabel option={option} slotted={slotted} /></SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  );
}
