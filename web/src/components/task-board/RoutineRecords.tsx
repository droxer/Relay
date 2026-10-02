"use client";

import { useMemo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  flexRender,
  type ColumnDef,
  type SortingState,
} from "@tanstack/react-table";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { SortColumnButton } from "@/components/ui/SortableColumnHeader";
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
import { sortIndicator, type SortState } from "../../lib/listSort";
import type { RelayTaskListItem } from "../../types";
import { useManualSortTable } from "../../hooks/useManualSortTable";
import { createCellState } from "../../lib/cellState";
import type { TFunction } from "i18next";

function hrefForRoutineRecord(routineId: string): string {
  return pathForAppState({ route: "routine", mobileView: "chat", sessionId: null, taskId: routineId });
}

/** The columns the routine list can order by. Mirrors `routineSortColumns`. */
export type RoutineSortKey = "title" | "priority" | "assignee" | "nextRun";

/** Per-column element classes, carried through TanStack's open `meta` slot. */
type ColumnChrome = { headClass?: string; cellClass?: string };

/** What the page resolves for one row's assignee chip. */
interface RoutineAssignment {
  name?: string;
  imageUrl?: string | null;
  ready: boolean;
}

/** The row's callbacks, resolved per task by the page that owns the mutations. */
interface RoutineHandlers {
  starting: boolean;
  /** Opens the routine's record. The title is a destination now, not a form. */
  onOpen: () => void;
  onEdit: () => void;
  onAssign: () => void;
  onStart: () => void;
}

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

interface RoutineCellState {
  t: TFunction;
  selectAll: ReactNode;
  selection: ReadonlySet<string>;
  onToggleSelect: (taskId: string) => void;
  onSort: (key: RoutineSortKey) => void;
  stateFor: (task: RelayTaskListItem) => RoutineState;
  assignmentFor: (task: RelayTaskListItem) => RoutineAssignment;
  handlersFor: (task: RelayTaskListItem) => RoutineHandlers;
}

const RoutineCells = createCellState<RoutineCellState>("RoutineTable");

/**
 * The routine list, rendered as one flat table: the rail beside it has
 * already said which schedule state is on screen, so there are no bands and
 * the header renders once.
 *
 * Sorting is manual — the page pre-orders `rows` through `routineSortColumns`
 * (whose missing-sinks-both-ways semantics TanStack's inversion cannot
 * express) and owns the state through `useListSort`; this table only maps
 * that state onto TanStack's controlled `sorting` and routes header clicks
 * back through the same `nextSortState` cycle the other lists speak.
 */
export function RoutineTable({
  rows,
  sort,
  onSort,
  ariaLabel,
  selectAll,
  selection,
  onToggleSelect,
  stateFor,
  assignmentFor,
  handlersFor,
}: {
  /** The already-sorted, already-paged records — pagination stays outside. */
  rows: RelayTaskListItem[];
  sort: SortState<RoutineSortKey> | null;
  onSort: (key: RoutineSortKey) => void;
  ariaLabel: string;
  /** The select-all control, built by the page against its own selection. */
  selectAll: ReactNode;
  selection: ReadonlySet<string>;
  onToggleSelect: (taskId: string) => void;
  stateFor: (task: RelayTaskListItem) => RoutineState;
  assignmentFor: (task: RelayTaskListItem) => RoutineAssignment;
  handlersFor: (task: RelayTaskListItem) => RoutineHandlers;
}) {
  const { t } = useTranslation();
  // Values that change under the stable column defs; cells read them
  // through RoutineCells (see lib/cellState).
  const cellState = useMemo<RoutineCellState>(
    () => ({ t, selectAll, selection, onToggleSelect, onSort, stateFor, assignmentFor, handlersFor }),
    [t, selectAll, selection, onToggleSelect, onSort, stateFor, assignmentFor, handlersFor],
  );
  const sorting = useMemo<SortingState>(
    () => (sort ? [{ id: sort.key, desc: sort.direction === "desc" }] : []),
    [sort],
  );

  function sortHead(key: RoutineSortKey, label: string): ReactNode {
    const { active, direction } = sortIndicator(sort, key);
    return (
      <RoutineCells.Read>
        {(s) => (
          <SortColumnButton
            label={label}
            sortKey={key}
            onSort={s.onSort}
            align="start"
            active={active}
            direction={direction}
          />
        )}
      </RoutineCells.Read>
    );
  }

  /* Column widths come from the old stylesheet's column block
     (backlog-list.css): select 16px, dot 8px, ref 68px, priority 104px,
     next run 150px, assignee 172px, actions 176px; the lead takes what is
     left. */
  const columns = useMemo<ColumnDef<RelayTaskListItem>[]>(
    () => [
      {
        id: "select",
        meta: { headClass: "w-4", cellClass: "w-4" } satisfies ColumnChrome,
        header: () => <RoutineCells.Read>{(s) => s.selectAll}</RoutineCells.Read>,
        cell: ({ row }) => <RoutineCells.Read>{(s) => {
          const task = row.original;
          const { t: say, selection: selected, onToggleSelect: toggle } = s;
          return (
            <TaskSelectCheckbox
              className="backlog-select-box"
              checked={selected.has(task.id)}
              label={say("routine.select_routine", { title: task.title })}
              onCheckedChange={() => toggle(task.id)}
            />
          );
        }}</RoutineCells.Read>,
      },
      {
        id: "state",
        meta: { headClass: "w-2", cellClass: "w-2" } satisfies ColumnChrome,
        /* Named, not blank: a columnheader with no accessible name leaves the
           cells under it reading as a column of nothing. */
        header: () => <RoutineCells.Read>{(s) => <span className="sr-only">{s.t("routine.state")}</span>}</RoutineCells.Read>,
        cell: ({ row }) => <RoutineCells.Read>{(s) => {
          const state = s.stateFor(row.original);
          const label = s.t(`routine.states.${state}`);
          /* The title gives a pointer the word the sr-only span gives a
             screen reader — the dot alone is shape and colour, not a name. */
          return (
            <span title={label}>
              <StateMark shape={ROUTINE_STATE_SHAPE[state]} />
              <span className="sr-only">{label}</span>
            </span>
          );
        }}</RoutineCells.Read>,
      },
      {
        id: "ref",
        meta: { headClass: "task-col-ref", cellClass: "code task-col-ref" } satisfies ColumnChrome,
        header: () => <RoutineCells.Read>{(s) => s.t("backlog.col_ref")}</RoutineCells.Read>,
        cell: ({ row }) => taskRef(row.original.id),
      },
      {
        id: "title",
        meta: { cellClass: "task-col-title" } satisfies ColumnChrome,
        header: () => <RoutineCells.Read>{(s) => sortHead("title", s.t("backlog.col_task"))}</RoutineCells.Read>,
        cell: ({ row }) => <RoutineCells.Read>{(s) => {
          const task = row.original;
          /* A real href, so a routine can be opened in a new tab or copied;
             a plain click navigates in place. */
          return (
            <a
              className="backlog-row-title"
              href={hrefForRoutineRecord(task.id)}
              onClick={(event) => {
                if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.altKey || event.ctrlKey || event.shiftKey) return;
                event.preventDefault();
                s.handlersFor(task).onOpen();
              }}
            >{task.title}</a>
          );
        }}</RoutineCells.Read>,
      },
      {
        id: "priority",
        meta: { headClass: "task-col-priority", cellClass: "task-col-priority" } satisfies ColumnChrome,
        header: () => <RoutineCells.Read>{(s) => sortHead("priority", s.t("backlog.priority"))}</RoutineCells.Read>,
        cell: ({ row }) => <PriorityBadge priority={row.original.priority} />,
      },
      {
        id: "nextRun",
        meta: { headClass: "task-col-due", cellClass: "task-col-due" } satisfies ColumnChrome,
        header: () => <RoutineCells.Read>{(s) => sortHead("nextRun", s.t("routine.next_run"))}</RoutineCells.Read>,
        cell: ({ row }) => <RoutineCells.Read>{(s) => {
          const task = row.original;
          return (
            <TaskDueCell
              date={task.routineNextRunDate}
              tone={routineDueTone(task)}
              format={formatNextRunDate}
              emptyLabel={s.t("routine.set_next_run")}
              onEdit={() => s.handlersFor(task).onEdit()}
            />
          );
        }}</RoutineCells.Read>,
      },
      {
        id: "assignee",
        meta: { headClass: "task-col-assignee", cellClass: "task-col-assignee" } satisfies ColumnChrome,
        header: () => <RoutineCells.Read>{(s) => sortHead("assignee", s.t("backlog.assignee"))}</RoutineCells.Read>,
        cell: ({ row }) => <RoutineCells.Read>{(s) => {
          const task = row.original;
          const assignment = s.assignmentFor(task);
          return (
            <TaskAssignee
              task={task}
              ready={assignment.ready}
              agentDisplayName={assignment.name}
              agentImageUrl={assignment.imageUrl}
            />
          );
        }}</RoutineCells.Read>,
      },
      {
        id: "actions",
        meta: { headClass: "task-col-actions", cellClass: "task-col-actions" } satisfies ColumnChrome,
        header: () => <RoutineCells.Read>{(s) => s.t("backlog.actions")}</RoutineCells.Read>,
        cell: ({ row }) => <RoutineCells.Read>{(s) => {
          const task = row.original;
          const { onAssign, onStart, starting } = s.handlersFor(task);
          const startDisabled = (!task.assignedAgentId && !task.assignedTeamId) || !task.routineEnabled;
          return (
            <div className="backlog-action-group" role="group" aria-label={s.t("backlog.actions_dispatch")}>
              <RoutineAssignButton onAssign={onAssign} />
              <RoutineStartButton disabled={startDisabled} onStart={onStart} starting={starting} />
            </div>
          );
        }}</RoutineCells.Read>,
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sort],
  );
  const table = useManualSortTable(rows, columns, sorting);

  return (
    <RoutineCells.Provider value={cellState}>
      <Table aria-label={ariaLabel}>
        <TableHeader>
          {table.getHeaderGroups().map((headerGroup) => (
            <TableRow key={headerGroup.id} className="hover:bg-transparent">
              {headerGroup.headers.map((header) => (
                <TableHead
                  key={header.id}
                  className={(header.column.columnDef.meta as ColumnChrome | undefined)?.headClass}
                  aria-sort={sort?.key === header.column.id ? sortIndicator(sort, header.column.id as RoutineSortKey).ariaSort : undefined}
                >
                  {flexRender(header.column.columnDef.header, header.getContext())}
                </TableHead>
              ))}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody>
          {table.getRowModel().rows.map((row) => {
            const task = row.original;
            return (
              <TableRow
                key={row.id}
                className="group"
                data-routine-state={stateFor(task)}
                data-priority={task.priority}
                data-selected={selection.has(task.id) ? "true" : undefined}
              >
                {row.getVisibleCells().map((cell) => (
                  <TableCell key={cell.id} className={(cell.column.columnDef.meta as ColumnChrome | undefined)?.cellClass}>
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </TableCell>
                ))}
              </TableRow>
            );
          })}
        </TableBody>
      </Table>

    </RoutineCells.Provider>
  );
}
