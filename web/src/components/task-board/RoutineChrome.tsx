"use client";

import { type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Input } from "@/components/ui/input";
import { StateMark } from "../StateMark";
import { ROUTINE_STATE_SHAPE } from "../RoutineStateBadge";
import { SectionNav, type SectionNavItem } from "../SectionNav";
import { FiltersBar, FilterSelect } from "../FiltersBar";
import {
  ROUTINE_STATE_ORDER,
  type RoutineState,
  TASK_ROUTINE_CADENCES,
  TASK_ROUTINE_TYPES,
  type RoutineFilters,
} from "../../lib/routine";
import type { FilterSpec } from "../../lib/urlFilters";
import type { EmployeeAgent } from "../../types";

/* Routine board chrome — the section rail and the filter bar. Split out of
   RoutinesPage the same way BacklogChrome was split out of BacklogPage: the
   page owns state and dispatch, these own presentation.

   There is no stat bar here on purpose. It counted Enabled / Due / Running
   over a board whose rail already names every schedule state with its count
   beside it — Running was the same number twice, Enabled was all-minus-paused
   and Due was overdue-plus-due, three arithmetics of the rail's own figures
   spending a band of the surface to restate them. */

export const initialRoutineFilters: RoutineFilters = {
  query: "",
  type: "all",
  cadence: "all",
  agent: "all",
  assignee: "",
  state: "all",
};

/* The query params the routine filter bar owns — must stay in sync with
   LIST_FILTER_PARAMS.routines in lib/appRoute.ts, which decides which of
   these survive canonicalization. */
export const ROUTINE_FILTER_SPEC: FilterSpec<RoutineFilters> = {
  query: { param: "q" },
  type: { param: "type", allowed: TASK_ROUTINE_TYPES },
  cadence: { param: "cadence", allowed: TASK_ROUTINE_CADENCES },
  agent: { param: "agent" },
  assignee: { param: "assignee" },
  state: { param: "state", allowed: ROUTINE_STATE_ORDER },
};

export function activeRoutineFilterCount(filters: RoutineFilters): number {
  let count = 0;
  if (filters.type !== "all") count += 1;
  if (filters.cadence !== "all") count += 1;
  if (filters.agent !== "all") count += 1;
  if (filters.assignee.trim()) count += 1;
  return count;
}

/* Date-only values ("2026-07-19") parse as UTC midnight; construct a local
   date so the rendered day does not shift with the viewer's timezone. */
export function formatNextRunDate(value: string): string {
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const date = dateOnly
    ? new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]))
    : new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(document.documentElement.lang || undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(date);
}

export function RoutineFiltersBar({ filters, agents, onChange, sortMenu }: { filters: RoutineFilters; agents: EmployeeAgent[]; onChange: (next: RoutineFilters) => void; sortMenu?: ReactNode }) {
  const { t } = useTranslation();

  return (
    <FiltersBar
      ariaLabel={t("routine.filters")}
      searchName="routine-query"
      searchLabel={t("routine.search")}
      query={filters.query}
      onQueryChange={(query) => onChange({ ...filters, query })}
      activeCount={activeRoutineFilterCount(filters)}
      /* The rail owns `state`, so clearing the BAR must not move the reader
         to another section — that control is not in this bar to be cleared. */
      onClear={() => onChange({ ...initialRoutineFilters, state: filters.state })}
      trailing={sortMenu}
    >
      <FilterSelect
        name="routine-type-filter"
        label={t("routine.type")}
        value={filters.type}
        onValueChange={(type) => onChange({ ...filters, type })}
        options={[
          { value: "all" as const, label: t("routine.all_types") },
          ...TASK_ROUTINE_TYPES.map((type) => ({ value: type, label: t(`routine.types.${type}`) })),
        ]}
      />
      <FilterSelect
        name="routine-cadence-filter"
        label={t("routine.cadence")}
        value={filters.cadence}
        onValueChange={(cadence) => onChange({ ...filters, cadence })}
        options={[
          { value: "all" as const, label: t("routine.all_cadences") },
          ...TASK_ROUTINE_CADENCES.map((cadence) => ({
            value: cadence,
            label: t(`routine.cadences.${cadence}`),
          })),
        ]}
      />
      <FilterSelect
        name="routine-agent-filter"
        label={t("backlog.agent")}
        value={filters.agent}
        onValueChange={(agent) => onChange({ ...filters, agent })}
        options={[
          { value: "all", label: t("backlog.all_agents") },
          ...agents.map((agent) => ({ value: agent.id, label: agent.displayName })),
        ]}
      />
      <Input name="routine-assignee-filter" autoComplete="off" spellCheck={false} value={filters.assignee} placeholder={t("backlog.assignee_filter")} aria-label={t("backlog.assignee_filter")} onChange={(event) => onChange({ ...filters, assignee: event.target.value })} />
    </FiltersBar>
  );
}

/** The rail's own vocabulary: every schedule state, under an "all" section. */
export type RoutineSection = "all" | RoutineState;

/**
 * The routine board's section rail — schedule health as a list of
 * destinations beside the board, in the shared `SectionNav` grammar.
 *
 * It is the ONE control for this dimension now. Schedule health used to be a
 * select in the filter bar AND the bands the list grouped on AND a sort
 * column, three grammars for one question; the rail replaced the first two.
 * It writes `filters.state`, so the section is `?state=` in the URL and a
 * link still lands where it says.
 */
export function RoutineStateNav({
  value,
  counts,
  total,
  onChange,
}: {
  value: RoutineSection;
  counts: Record<RoutineState, number>;
  total: number;
  onChange: (next: RoutineSection) => void;
}) {
  const { t } = useTranslation();
  const items: SectionNavItem<RoutineSection>[] = [
    { id: "all", label: t("routine.all_states"), count: total },
    ...ROUTINE_STATE_ORDER.map((state) => ({
      id: state,
      label: t(`routine.states.${state}`),
      mark: <StateMark shape={ROUTINE_STATE_SHAPE[state]} />,
      count: counts[state] ?? 0,
    })),
  ];

  return (
    <SectionNav
      items={items}
      value={value}
      onChange={onChange}
      label={t("routine.state")}
    />
  );
}
