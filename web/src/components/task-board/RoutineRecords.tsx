"use client";

import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { ActionStart, ICON, NavAgents } from "../icons";
import { PriorityBadge } from "../PriorityBadge";
import { StateMark } from "../StateMark";
import { ROUTINE_STATE_SHAPE } from "../RoutineStateBadge";
import { TaskAssignee } from "../TaskAssignee";
import { TaskSelectCheckbox } from "./TaskSelection";
import { formatNextRunDate } from "./RoutineChrome";
import { routineDueTone, type RoutineState } from "../../lib/routine";
import { pathForAppState } from "../../lib/appRoute";
import { taskRef } from "../../lib/taskRef";
import { TaskDueCell } from "./TaskDueCell";
import { SortableColumnHeader } from "@/components/ui/SortableColumnHeader";
import type { SortState } from "../../lib/listSort";
import type { ReactNode } from "react";

function hrefForRoutineRecord(routineId: string): string {
  return pathForAppState({ route: "routine", mobileView: "chat", sessionId: null, taskId: routineId });
}

/** The columns the routine list can order by. Mirrors `routineSortColumns`. */
export type RoutineSortKey = "title" | "priority" | "assignee" | "nextRun";
import type { RelayTaskListItem } from "../../types";
import { TableCell, TableHead, TableRow } from "@/components/ui/table";

/* One routine, as a list row. The row is the same record grammar the backlog
   row is — keep their badge order and action group in step.

   Default values render nothing here, because this surface is scanned. The
   record surface passes `always` to the same badges, because a record being
   inspected has to show the value it holds even when it is the default. */

export function RoutineStartButton({
  disabled,
  onStart,
  starting,
}: {
  disabled: boolean;
  onStart: () => void;
  starting: boolean;
}) {
  const { t } = useTranslation();

  return (
    <Button
      variant="icon"
      size="icon-dense"
      tinted
      type="button"
      className="backlog-action-primary backlog-action-icon"
      onClick={onStart}
      disabled={disabled}
      loading={starting}
      aria-label={t("backlog.start")}
      title={t("backlog.start")}
    >
      <ActionStart size={ICON.sm} />
    </Button>
  );
}

export function RoutineAssignButton({ onAssign }: { onAssign: () => void }) {
  const { t } = useTranslation();

  return (
    <Button
      variant="icon"
      size="icon-dense"
      type="button"
      className="backlog-action-icon"
      onClick={onAssign}
      aria-label={t("backlog.assign_task")}
      title={t("backlog.assign_task")}
    >
      <NavAgents size={ICON.sm} />
    </Button>
  );
}

/**
 * The routine list's column header row, rendered once above the flat list —
 * same contract as `BacklogRowsHead`, and deliberately the same columns in
 * the same order: the two lists are one record grammar in two vocabularies.
 */
export function RoutineRowsHead({
  sort,
  onSort,
  selectAll,
}: {
  sort: SortState<RoutineSortKey> | null;
  onSort: (key: RoutineSortKey) => void;
  selectAll: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <TableRow className="backlog-rows-head">
      <TableHead className="backlog-rows-head-cell backlog-rows-head-select">{selectAll}</TableHead>
      {/* Named, not blank — see BacklogRowsHead. */}
      <TableHead className="backlog-rows-head-cell backlog-rows-head-dot">
        <span className="sr-only">{t("routine.state")}</span>
      </TableHead>
      <TableHead className="backlog-rows-head-cell backlog-rows-head-ref">{t("backlog.col_ref")}</TableHead>
      <SortableColumnHeader
        className="backlog-rows-head-cell backlog-rows-head-lead"
        label={t("backlog.col_task")}
        sortKey="title"
        sort={sort}
        onSort={onSort}
      />
      <SortableColumnHeader
        className="backlog-rows-head-cell backlog-rows-head-tags"
        label={t("backlog.priority")}
        sortKey="priority"
        sort={sort}
        onSort={onSort}
      />
      <SortableColumnHeader
        className="backlog-rows-head-cell backlog-rows-head-due"
        label={t("routine.next_run")}
        sortKey="nextRun"
        sort={sort}
        onSort={onSort}
      />
      <SortableColumnHeader
        className="backlog-rows-head-cell backlog-rows-head-assignee"
        label={t("backlog.assignee")}
        sortKey="assignee"
        sort={sort}
        onSort={onSort}
      />
      <TableHead className="backlog-rows-head-cell backlog-rows-head-actions">{t("backlog.actions")}</TableHead>
    </TableRow>
  );
}

export function RoutineRow({
  task,
  state,
  ready,
  agentDisplayName,
  selected,
  onToggleSelect,
  onOpen,
  onEdit,
  onAssign,
  onStart,
  starting,
}: {
  task: RelayTaskListItem;
  state: RoutineState;
  ready: boolean;
  agentDisplayName?: string;
  selected: boolean;
  onToggleSelect: () => void;
  /** Opens the routine's record. The title is a destination now, not a form. */
  onOpen: () => void;
  onEdit: () => void;
  onAssign: () => void;
  onStart: () => void;
  starting: boolean;
}) {
  const { t } = useTranslation();
  const tone = routineDueTone(task);
  const startDisabled = (!task.assignedAgentId && !task.assignedTeamId) || !task.routineEnabled;

  return (
    <TableRow render={<article />} className="backlog-row group list-virtual" data-routine-state={state} data-priority={task.priority} data-selected={selected ? "true" : undefined}>
      <TableCell className="backlog-row-select-cell">
        <TaskSelectCheckbox
          className="backlog-select-box"
          checked={selected}
          label={t("routine.select_routine", { title: task.title })}
          onCheckedChange={onToggleSelect}
        />
      </TableCell>
      {/* A cell carrying the state as a shape and a word — see BacklogRow. */}
      <TableCell className="backlog-row-dot-cell">
        <StateMark shape={ROUTINE_STATE_SHAPE[state]} />
        <span className="sr-only">{t(`routine.states.${state}`)}</span>
      </TableCell>
      <TableCell className="backlog-row-ref code">{taskRef(task.id)}</TableCell>
      <TableCell render={<div />} className="backlog-row-lead">
        {/* A real href, so a routine can be opened in a new tab or copied;
            a plain click navigates in place. */}
        <a
          className="backlog-row-title"
          href={hrefForRoutineRecord(task.id)}
          onClick={(event) => {
            if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.altKey || event.ctrlKey || event.shiftKey) return;
            event.preventDefault();
            onOpen();
          }}
        >{task.title}</a>
      </TableCell>
      <TableCell render={<div />} className="backlog-row-tags">
        <PriorityBadge priority={task.priority} />
      </TableCell>
      <TableCell className="backlog-row-due">
        <TaskDueCell
          date={task.routineNextRunDate}
          tone={tone}
          format={formatNextRunDate}
          emptyLabel={t("routine.set_next_run")}
          onEdit={onEdit}
        />
      </TableCell>
      <TableCell className="backlog-row-assignee">
        <TaskAssignee task={task} ready={ready} agentDisplayName={agentDisplayName} />
      </TableCell>
      <TableCell render={<div />} className="backlog-row-actions" aria-label={t("backlog.actions")}>
        <div className="backlog-action-group" role="group" aria-label={t("backlog.actions_dispatch")}>
          <RoutineAssignButton onAssign={onAssign} />
          <RoutineStartButton disabled={startDisabled} onStart={onStart} starting={starting} />
        </div>
      </TableCell>
    </TableRow>
  );
}
