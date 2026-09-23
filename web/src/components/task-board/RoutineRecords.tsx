"use client";

import { useMemo, useRef, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
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

function hrefForRoutineRecord(routineId: string): string {
  return pathForAppState({ route: "routine", mobileView: "chat", sessionId: null, taskId: routineId });
}

/** The columns the routine list can order by. Mirrors `routineSortColumns`. */
export type RoutineSortKey = "title" | "priority" | "assignee" | "nextRun";

/** Per-column element classes, carried through TanStack's open `meta` slot. */
type ColumnChrome = { headClass?: string; cellClass?: string };

/** What the page resolves for one row's assignee chip. */
export interface RoutineAssignment {
  name?: string;
  imageUrl?: string | null;
  ready: boolean;
}

/** The row's callbacks, resolved per task by the page that owns the mutations. */
export interface RoutineHandlers {
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
  /* flexRender mounts a column's cell/header function AS a component, so a
     column def that closes over render-volatile values — `t`, the per-task
     handler factories, the selection set, the caller's inline `selectAll`
     node — would unmount and remount every cell subtree each render. The
     column defs below therefore stay stable across those values and read
     them through this ref at render time. */
  const stateRef = useRef({ t, selectAll, selection, onToggleSelect, onSort, stateFor, assignmentFor, handlersFor });
  stateRef.current = { t, selectAll, selection, onToggleSelect, onSort, stateFor, assignmentFor, handlersFor };
  const sorting = useMemo<SortingState>(
    () => (sort ? [{ id: sort.key, desc: sort.direction === "desc" }] : []),
    [sort],
  );

  function sortHead(key: RoutineSortKey, label: string): ReactNode {
    const { active, direction } = sortIndicator(sort, key);
    return (
      <SortColumnButton
        label={label}
        sortKey={key}
        onSort={(nextKey) => stateRef.current.onSort(nextKey)}
        align="start"
        active={active}
        direction={direction}
      />
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
        header: () => stateRef.current.selectAll,
        cell: ({ row }) => {
          const task = row.original;
          const { t: say, selection: selected, onToggleSelect: toggle } = stateRef.current;
          return (
            <TaskSelectCheckbox
              className="backlog-select-box"
              checked={selected.has(task.id)}
              label={say("routine.select_routine", { title: task.title })}
              onCheckedChange={() => toggle(task.id)}
            />
          );
        },
      },
      {
        id: "state",
        meta: { headClass: "w-2", cellClass: "w-2" } satisfies ColumnChrome,
        /* Named, not blank: a columnheader with no accessible name leaves the
           cells under it reading as a column of nothing. */
        header: () => <span className="sr-only">{stateRef.current.t("routine.state")}</span>,
        cell: ({ row }) => {
          const state = stateRef.current.stateFor(row.original);
          return (
            <>
              <StateMark shape={ROUTINE_STATE_SHAPE[state]} />
              <span className="sr-only">{stateRef.current.t(`routine.states.${state}`)}</span>
            </>
          );
        },
      },
      {
        id: "ref",
        meta: { headClass: "task-col-ref", cellClass: "code task-col-ref" } satisfies ColumnChrome,
        header: () => stateRef.current.t("backlog.col_ref"),
        cell: ({ row }) => taskRef(row.original.id),
      },
      {
        id: "title",
        meta: { cellClass: "max-w-md" } satisfies ColumnChrome,
        header: () => sortHead("title", stateRef.current.t("backlog.col_task")),
        cell: ({ row }) => {
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
                stateRef.current.handlersFor(task).onOpen();
              }}
            >{task.title}</a>
          );
        },
      },
      {
        id: "priority",
        meta: { headClass: "task-col-priority", cellClass: "task-col-priority" } satisfies ColumnChrome,
        header: () => sortHead("priority", stateRef.current.t("backlog.priority")),
        cell: ({ row }) => <PriorityBadge priority={row.original.priority} />,
      },
      {
        id: "nextRun",
        meta: { headClass: "task-col-due", cellClass: "task-col-due" } satisfies ColumnChrome,
        header: () => sortHead("nextRun", stateRef.current.t("routine.next_run")),
        cell: ({ row }) => {
          const task = row.original;
          return (
            <TaskDueCell
              date={task.routineNextRunDate}
              tone={routineDueTone(task)}
              format={formatNextRunDate}
              emptyLabel={stateRef.current.t("routine.set_next_run")}
              onEdit={() => stateRef.current.handlersFor(task).onEdit()}
            />
          );
        },
      },
      {
        id: "assignee",
        meta: { headClass: "task-col-assignee", cellClass: "task-col-assignee" } satisfies ColumnChrome,
        header: () => sortHead("assignee", stateRef.current.t("backlog.assignee")),
        cell: ({ row }) => {
          const task = row.original;
          const assignment = stateRef.current.assignmentFor(task);
          return (
            <TaskAssignee
              task={task}
              ready={assignment.ready}
              agentDisplayName={assignment.name}
              agentImageUrl={assignment.imageUrl}
            />
          );
        },
      },
      {
        id: "actions",
        meta: { headClass: "task-col-actions", cellClass: "task-col-actions" } satisfies ColumnChrome,
        header: () => stateRef.current.t("backlog.actions"),
        cell: ({ row }) => {
          const task = row.original;
          const { onAssign, onStart, starting } = stateRef.current.handlersFor(task);
          const startDisabled = (!task.assignedAgentId && !task.assignedTeamId) || !task.routineEnabled;
          return (
            <div className="backlog-action-group" role="group" aria-label={stateRef.current.t("backlog.actions_dispatch")}>
              <RoutineAssignButton onAssign={onAssign} />
              <RoutineStartButton disabled={startDisabled} onStart={onStart} starting={starting} />
            </div>
          );
        },
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sort],
  );
  const table = useReactTable({
    data: rows,
    columns,
    state: { sorting },
    manualSorting: true,
    getCoreRowModel: getCoreRowModel(),
    getRowId: (task) => task.id,
  });

  return (
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
  );
}
