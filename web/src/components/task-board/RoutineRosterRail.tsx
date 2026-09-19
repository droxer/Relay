"use client";

import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { SearchInput } from "@/components/ui/search-input";
import { FilterSelect } from "../FiltersBar";
import { PageHeader } from "../PageHeader";
import { RelayEmptyState } from "../RelayEmptyState";
import { StateMark } from "../StateMark";
import { ROUTINE_STATE_SHAPE } from "../RoutineStateBadge";
import { ActionAdd, ICON } from "../icons";
import { formatNextRunDate } from "./RoutineChrome";
import { ROUTINE_STATE_ORDER, type RoutineState } from "../../lib/routine";
import type { RelayTaskListItem } from "../../types";

/* The routine board's rail: every routine as a record, not a list of schedule
   states to filter by.

   It replaced a SectionNav of the six schedule states. Sections were the
   wrong noun for this surface — a routine IS the thing being read, and the
   states were only ever a way of reaching one. So the rail lists routines and
   the state rides on the row as its mark, with one select above for narrowing
   to a state. Same row contract as the thread, project, agent, and team rails
   (`rail-row` in tokens/base.css owns selection). */

export type RoutineStateFilter = "all" | RoutineState;

export function RoutineRosterRail({
  routines,
  stateOf,
  totalCount,
  selectedId,
  query,
  state,
  onQueryChange,
  onStateChange,
  onSelect,
  onCreate,
}: {
  /** Already filtered and ordered — the page owns both. */
  routines: RelayTaskListItem[];
  /** Schedule health of one routine. Derived, and derived ONCE for the whole
   *  board (it needs the running-occurrence set), so the page hands it down
   *  rather than each row recomputing it. */
  stateOf: (routine: RelayTaskListItem) => RoutineState;
  /** Every routine the employee has, filtered or not: the rail's own count. */
  totalCount: number;
  selectedId: string | null;
  query: string;
  state: RoutineStateFilter;
  onQueryChange: (query: string) => void;
  onStateChange: (state: RoutineStateFilter) => void;
  onSelect: (taskId: string) => void;
  onCreate: () => void;
}) {
  const { t } = useTranslation();

  return (
    <div className="routine-roster" aria-label={t("routine.title")}>
      <PageHeader
        kicker={t("nav.workspace")}
        title={t("routine.title")}
        count={t("routine.sub", { count: totalCount })}
        titleVariant="display"
        layout="stacked"
        actions={
          // The shared list-header create affordance — a ghost plus, same as
          // the agents, projects, and threads rails.
          <Button
            variant="ghost"
            type="button"
            className="page-header-icon-action"
            tooltip={t("routine.new")}
            onClick={onCreate}
          >
            <ActionAdd size={ICON.md} aria-hidden="true" />
          </Button>
        }
      />

      <div className="list-filter-bar" role="group" aria-label={t("routine.filters")}>
        <SearchInput
          className="list-filter-search"
          iconSize={ICON.sm}
          label={t("routine.search")}
          placeholder={t("routine.search")}
          name="routine-query"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
        />
        <FilterSelect
          name="routine-state-filter"
          className="routine-roster-select"
          label={t("routine.state")}
          value={state}
          onValueChange={onStateChange}
          options={[
            { value: "all" as const, label: t("routine.all_states") },
            ...ROUTINE_STATE_ORDER.map((value) => ({ value, label: t(`routine.states.${value}`) })),
          ]}
        />
      </div>

      {routines.length === 0 ? (
        <RelayEmptyState
          title={totalCount === 0 ? t("routine.no_routines_title") : t("routine.no_match_title")}
          body={totalCount === 0 ? t("routine.no_routines_body") : t("routine.no_match_body")}
        />
      ) : (
        /* Compact density, like every list rail: a ~320px rail is a list
           layout, so the name sits one rung down beside its meta line. */
        <ul className="routine-roster-list" data-density="compact" aria-label={t("routine.title")}>
          {routines.map((routine) => (
            <RoutineRosterRow
              key={routine.id}
              routine={routine}
              state={stateOf(routine)}
              selected={routine.id === selectedId}
              onSelect={() => onSelect(routine.id)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function RoutineRosterRow({
  routine,
  state,
  selected,
  onSelect,
}: {
  routine: RelayTaskListItem;
  state: RoutineState;
  selected: boolean;
  onSelect: () => void;
}) {
  const { t } = useTranslation();

  return (
    <li className="list-virtual">
      <article
        className="routine-roster-row rail-row"
        data-routine-state={state}
        data-selected={selected ? "true" : "false"}
      >
        <Button
          variant="ghost"
          type="button"
          className="routine-roster-row-select"
          aria-current={selected ? "page" : undefined}
          onClick={onSelect}
        >
          {/* The state as a mark plus a word for anyone who cannot see it —
              the dot-plus-sr-only grammar the list rows use. */}
          <span className="routine-roster-row-mark">
            <StateMark shape={ROUTINE_STATE_SHAPE[state]} />
            <span className="sr-only">{t(`routine.states.${state}`)}</span>
          </span>
          <span className="routine-roster-row-main">
            <span className="routine-roster-row-name">{routine.title}</span>
            <span className="routine-roster-row-meta">
              {t(`routine.cadences.${routine.routineCadence ?? "weekly"}`)}
              {routine.routineNextRunDate ? ` · ${formatNextRunDate(routine.routineNextRunDate)}` : ""}
            </span>
          </span>
        </Button>
      </article>
    </li>
  );
}
