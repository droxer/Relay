"use client";

import { skipToken, useQuery } from "@tanstack/react-query";
import { taskFlowMetrics } from "../../lib/taskFlow";
import { useMemo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { type AgentTeam, type EmployeeAgent, type RelayTaskListItem, type TaskStatus } from "../../types";
import {
  ICON,
  ViewBoard,
  ViewList,
} from "../icons";
import { dueTone, TASK_PRIORITIES, TASK_STATUSES, type BacklogFilters } from "../../lib/backlog";
import { Button } from "@/components/ui/button";
import { FiltersBar, type FilterBarField } from "../FiltersBar";
import { selectionsFromState, stateFromSelections } from "../../lib/filterSelections";
import { SectionNav, type SectionNavItem } from "../SectionNav";
import { TASK_STATUS_SHAPE } from "./backlogVocabulary";
import { StateMark, shapeForCount } from "../StateMark";

import { initialFilters, type BacklogView } from "./backlogVocabulary";

/**
 * The board's chrome, as against its records: the inline stat bar, the filter
 * bar, and the board/list view toggle. Split out of a 971-line BacklogPage.tsx.
 */

export function BacklogStats({ tasks }: { tasks: RelayTaskListItem[] }) {
  const { t } = useTranslation();
  const flow = taskFlowMetrics(tasks);
  const { data: policy } = useQuery<{ wipLimit: number; scope: string }>({
    queryKey: ["task-flow-policy"],
    queryFn: skipToken,
  });
  const stats = useMemo(() => {
    const active = taskFlowMetrics(tasks).wip;
    const blocked = tasks.filter((task) => task.status === "blocked").length;
    const overdue = tasks.filter((task) => dueTone(task) === "bad").length;
    return { total: tasks.length, active, blocked, overdue };
  }, [tasks]);

  return (
    <p className="backlog-stats" role="group" aria-label={t("backlog.metrics")}>
      <span className="backlog-stat">
        <span className="backlog-stat-eyebrow">{t("backlog.metric_total")}</span>
        <span className="backlog-stat-value">{stats.total}</span>
      </span>
      <span className="backlog-stat">
        <span className="backlog-stat-eyebrow">{t("backlog.metric_active")}</span>
        <span className="backlog-stat-value">{stats.active}</span>
      </span>
      <span className="backlog-stat">
        <span className="backlog-stat-eyebrow">{t("backlog.wip_limit")}</span>
        <span className="backlog-stat-value">{policy?.wipLimit ?? "—"}</span>
      </span>
      <span className="backlog-stat">
        <span className="backlog-stat-eyebrow">{t("backlog.metric_blocked")}</span>
        <span className="backlog-stat-value">
          {stats.blocked > 0 ? <StateMark shape="ring" className="backlog-stat-mark" /> : null}
          {stats.blocked}
        </span>
      </span>
      <span className="backlog-stat">
        <span className="backlog-stat-eyebrow">{t("backlog.metric_overdue")}</span>
        <span className="backlog-stat-value">
          {stats.overdue > 0 ? <StateMark shape="ring" className="backlog-stat-mark" /> : null}
          {stats.overdue}
        </span>
      </span>
      <span className="backlog-stat"><span className="backlog-stat-eyebrow">{t("backlog.oldest_age")}</span><span className="backlog-stat-value">{flow.oldestAgeDays === null ? "—" : `${flow.oldestAgeDays.toFixed(1)}d`}</span></span>
      <span className="backlog-stat"><span className="backlog-stat-eyebrow">{t("backlog.throughput")}</span><span className="backlog-stat-value">{flow.throughput}</span></span>
      <span className="backlog-stat"><span className="backlog-stat-eyebrow">{t("backlog.cycle_time")}</span><span className="backlog-stat-value">{flow.averageCycleDays === null ? "—" : `${flow.averageCycleDays.toFixed(1)}d`}</span></span>
      <span className="backlog-stat"><span className="backlog-stat-eyebrow">{t(flow.sleIsEstimate ? "backlog.sle_estimate" : "backlog.sle")}</span><span className="backlog-stat-value">{flow.sleDays.toFixed(1)}d</span></span>
    </p>
  );
}
export function formatDueDate(value: string): string {
  // Date-only values ("2026-07-19") parse as UTC midnight; construct a local
  // date so the rendered day does not shift with the viewer's timezone.
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
/** A filter one page adds to the backlog bar — the project on the backlog, the status on a project. */
export interface ExtraBacklogFilter {
  field: FilterBarField;
  value: string;
  onChange: (value: string) => void;
}

/* The bar's fields, as the page state names them. "all" is how the state
   says "not filtering"; the chips say it by having no chip. */
const BACKLOG_BAR_KEYS = ["priority", "due", "agent", "team", "assignment", "assignee", "source"] as const;

export function BacklogFiltersBar({
  sortMenu,
  extraField,
  filters,
  agents,
  teams,
  onChange,
}: {
  filters: BacklogFilters;
  agents: EmployeeAgent[];
  teams: AgentTeam[];
  onChange: (next: BacklogFilters) => void;
  /** The narrow-width sort control; see SortMenu. */
  sortMenu?: ReactNode;
  extraField?: ExtraBacklogFilter;
}) {
  const { t } = useTranslation();
  const fields = useMemo<FilterBarField[]>(() => [
    ...(extraField ? [extraField.field] : []),
    { id: "priority", label: t("backlog.priority"), kind: "select",
      options: TASK_PRIORITIES.map((priority) => ({ value: priority, label: t(`backlog.priorities.${priority}`) })) },
    { id: "due", label: t("backlog.due"), kind: "select", options: [
      { value: "overdue", label: t("backlog.overdue") },
      { value: "today", label: t("backlog.today") },
      { value: "next_week", label: t("backlog.next_week") },
      { value: "unscheduled", label: t("backlog.unscheduled") },
    ] },
    { id: "agent", label: t("backlog.agent"), kind: "select",
      options: agents.map((agent) => ({ value: agent.id, label: agent.displayName })) },
    { id: "team", label: t("backlog.team_filter"), kind: "select",
      options: teams.map((team) => ({ value: team.id, label: team.name })) },
    { id: "assignment", label: t("backlog.assignment_filter"), kind: "select", options: [
      { value: "assigned", label: t("backlog.with_assignment") },
      { value: "unassigned", label: t("backlog.without_assignment") },
    ] },
    { id: "assignee", label: t("backlog.assignee_filter"), kind: "text" },
    { id: "source", label: t("backlog.source"), kind: "select", options: [
      { value: "direct", label: t("backlog.source_direct") },
      { value: "routine", label: t("backlog.source_routine") },
    ] },
  ], [agents, teams, t, extraField?.field]);
  const selections = {
    ...(extraField ? { [extraField.field.id]: extraField.value } : {}),
    ...selectionsFromState(filters, BACKLOG_BAR_KEYS),
  };

  return (
    <FiltersBar
      ariaLabel={t("backlog.filters")}
      searchName="backlog-query"
      searchLabel={t("backlog.search")}
      query={filters.query}
      onQueryChange={(query) => onChange({ ...filters, query })}
      fields={fields}
      selections={selections}
      onSelectionsChange={(next) => {
        if (extraField && next[extraField.field.id] !== extraField.value) extraField.onChange(next[extraField.field.id]);
        const bar = stateFromSelections(next, BACKLOG_BAR_KEYS, ["assignee"]);
        if (BACKLOG_BAR_KEYS.some((key) => bar[key] !== filters[key])) onChange({ ...filters, ...bar } as BacklogFilters);
      }}
      /* The extra field (the project, a project's status) is the page's, not
         the bar's: Clear leaves it, as it always has. */
      onClear={() => onChange({ ...initialFilters, status: filters.status })}
      clearableCount={BACKLOG_BAR_KEYS.filter((key) => filters[key] !== "all" && filters[key] !== "").length}
      trailing={sortMenu}
    />
  );
}
export function BacklogViewToggle({ view, onChange }: { view: BacklogView; onChange: (view: BacklogView) => void }) {
  const { t } = useTranslation();
  return (
    <div className="backlog-view-toggle" role="group" aria-label={t("backlog.view")}>
      <Button variant="ghost"
        type="button"
        className="backlog-view-btn"
        data-active={view === "board" ? "true" : "false"}
        aria-pressed={view === "board"}
        tooltip={t("backlog.view_board")}
        onClick={() => onChange("board")}
      >
        <ViewBoard size={ICON.sm} />
      </Button>
      <Button variant="ghost"
        type="button"
        className="backlog-view-btn"
        data-active={view === "list" ? "true" : "false"}
        aria-pressed={view === "list"}
        tooltip={t("backlog.view_list")}
        onClick={() => onChange("list")}
      >
        <ViewList size={ICON.sm} />
      </Button>
    </div>
  );
}

/** Same section navigation as Routines; the filter bar owns other dimensions. */
export function TaskStatusNav({ value, counts, onChange }: {
  value: "all" | TaskStatus;
  counts: Record<TaskStatus, number>;
  onChange: (status: "all" | TaskStatus) => void;
}) {
  const { t } = useTranslation();
  const items: SectionNavItem<"all" | TaskStatus>[] = [
    { id: "all", label: t("backlog.title"), count: Object.values(counts).reduce((sum, count) => sum + count, 0) },
    ...TASK_STATUSES.map((status) => ({
      id: status,
      label: t(`backlog.statuses.${status}`),
      mark: <StateMark shape={shapeForCount(TASK_STATUS_SHAPE[status], counts[status])} />,
      count: counts[status],
    })),
  ];
  return <SectionNav items={items} value={value} onChange={onChange} label={t("backlog.status")} />;
}
