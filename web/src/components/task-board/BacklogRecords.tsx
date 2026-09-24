"use client";

import { useMemo, useRef, type ComponentProps, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { PriorityBadge } from "../PriorityBadge";
import { cn } from "@/lib/utils";
import { type RelaySession, type RelayTaskListItem } from "../../types";
import { ActionCalendar, ICON } from "../icons";
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
} from "@tanstack/react-table";
import { dueTone, type BacklogSortKey } from "../../lib/backlog";
import { taskExceptions, taskWorkAgeDays } from "../../lib/taskExceptions";
import { pathForAppState } from "../../lib/appRoute";

export function hrefForTaskRecord(taskId: string): string {
  return pathForAppState({ route: "backlog", mobileView: "chat", sessionId: null, taskId });
}
import { TaskAssignee } from "../TaskAssignee";
import { StateMark } from "../StateMark";
import { SortColumnButton } from "@/components/ui/SortableColumnHeader";
import { sortIndicator, type SortState } from "../../lib/listSort";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

import { TaskSelectCheckbox } from "./TaskSelection";
import { TASK_STATUS_SHAPE } from "./backlogVocabulary";
import { formatDueDate } from "./BacklogChrome";

/**
 * The two ways a task renders: as a card on the board and as a row in the
 * list. Split out of a 971-line BacklogPage.tsx.
 *
 * They live together because they are one record shown two ways — the same
 * status shape, the same assignee chip, the same due-date treatment — and
 * keeping them side by side is what stops the board and the list drifting
 * into two different vocabularies for one task.
 */

export function BacklogTaskCard({
  task,
  projectName,
  ready,
  agentDisplayName,
  agentImageUrl,
  selected,
  onToggleSelect,
  onOpen,
  className,
  ...dragProps
}: {
  task: RelayTaskListItem;
  projectName?: string;
  ready: boolean;
  agentDisplayName?: string;
  agentImageUrl?: string | null;
  selected: boolean;
  onToggleSelect: () => void;
  /** Opens the record drawer. The title is a destination now, not a form. */
  onOpen: () => void;
  /* The board's KanbanItem renders the card and hands it the drag wiring —
     ref, pointer/keyboard listeners, the sortable a11y attributes, the
     transform style and `data-dragging`. The card applies them to its own
     root rather than growing a wrapper element around it. */
} & Omit<ComponentProps<"article">, "children">) {
  const { t } = useTranslation();
  const tone = dueTone(task);
  const age = taskWorkAgeDays(task);

  return (
    <article
      {...dragProps}
      className={cn("backlog-task group list-virtual", className)}
      data-priority={task.priority}
      data-selected={selected ? "true" : undefined}
    >
      {/* The card is a tile: a title and one facts line. Everything else the
          record carries — prose, exceptions, provenance, outcome, actions —
          is one click away in the record drawer; a lane of tiles is a
          scanning surface, not seven small dossiers. The checkbox holds the
          control gutter (a selection control that moves with the content is
          unusable) and the title and facts line share one left edge. */}
      <div className="backlog-card-head">
        <TaskSelectCheckbox
          className="backlog-select-box"
          checked={selected}
          label={t("backlog.select_task", { title: task.title })}
          onCheckedChange={onToggleSelect}
        />
        <div className="backlog-card-body">
          <a
          className="backlog-task-title"
          href={hrefForTaskRecord(task.id)}
          onClick={(event) => {
            if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.altKey || event.ctrlKey || event.shiftKey) return;
            event.preventDefault();
            onOpen();
          }}
        >{task.title}</a>
        {projectName ? <span className="task-project-label">{projectName}</span> : null}
          {/* One line of facts, and only facts the lane above does not already
              state: no status word (the lane IS the status) and no "No due
              date" on every undated card. The agent is named — a bare
              executor glyph identified nothing on a card with room to spell
              it. */}
          <div className="backlog-meta">
            <PriorityBadge priority={task.priority} />
            {age !== null ? <span className="tnum">{t("backlog.work_age", { days: age.toFixed(1) })}</span> : null}
            <TaskAssignee task={task} ready={ready} agentDisplayName={agentDisplayName} agentImageUrl={agentImageUrl} />
            {task.dueDate ? (
              <span className={cn("backlog-due", tone !== "neutral" && tone)}>
                <ActionCalendar size={ICON.sm} />
                {formatDueDate(task.dueDate)}
              </span>
            ) : null}
          </div>
        </div>
      </div>
    </article>
  );
}
/** Per-column element classes, carried through TanStack's open `meta` slot. */
type ColumnChrome = { headClass?: string; cellClass?: string };

/** What a row needs beyond the task itself, resolved by the page per record. */
export interface BacklogRowContext {
  projectName?: string;
  ready: boolean;
  agentDisplayName?: string;
  agentImageUrl?: string | null;
}

/**
 * The backlog's flat list: one table over the already-filtered, sorted, and
 * paged records the page hands down. The column header renders ONCE, above
 * every row — it used to repeat per group, and at the density these lists
 * run at four bands meant four identical header rows for six records, so the
 * furniture outweighed the content.
 *
 * Sorting stays manual and URL-backed: the page owns the state
 * (`useListSort`) and the ordering (`applySort`); the table only projects
 * that state onto TanStack's `SortingState` and routes header clicks back
 * through the same `nextSortState` cycle the other lists speak.
 */
export function BacklogTaskList({
  tasks,
  sort,
  onSort,
  selectAll,
  selectedIds,
  onToggleSelect,
  contextFor,
  onOpenTask,
}: {
  /** The current page of records, in display order. */
  tasks: RelayTaskListItem[];
  sort: SortState<BacklogSortKey> | null;
  onSort: (key: BacklogSortKey) => void;
  selectAll: ReactNode;
  selectedIds: ReadonlySet<string>;
  onToggleSelect: (taskId: string) => void;
  contextFor: (task: RelayTaskListItem) => BacklogRowContext;
  /** Opens the task's record. The title is a destination now, not a form. */
  onOpenTask: (taskId: string) => void;
}) {
  const { t } = useTranslation();
  /* flexRender mounts a column's cell function AS a component, so a column
     def that closed over render-volatile values — `t`, the caller's inline
     `contextFor`, the selection set on every toggle — would unmount and
     remount every cell subtree each time. The defs below stay stable across
     those values and read them through this ref at render time. */
  const state = useRef({ t, onSort, selectAll, selectedIds, onToggleSelect, contextFor, onOpenTask });
  state.current = { t, onSort, selectAll, selectedIds, onToggleSelect, contextFor, onOpenTask };
  /* TanStack's controlled sorting state is a projection of the page's
     URL-backed SortState; nothing inside the table writes it back (header
     clicks go through `onSort`), which is what `manualSorting` licenses. */
  const sorting = useMemo<SortingState>(
    () => (sort ? [{ id: sort.key, desc: sort.direction === "desc" }] : []),
    [sort],
  );

  function sortHead(key: BacklogSortKey, label: string): ReactNode {
    const { active, direction } = sortIndicator(sort, key);
    return (
      <SortColumnButton
        label={label}
        sortKey={key}
        onSort={(next) => state.current.onSort(next)}
        align="start"
        active={active}
        direction={direction}
      />
    );
  }

  const columns = useMemo<ColumnDef<RelayTaskListItem>[]>(() => [
    {
      id: "select",
      meta: { headClass: "w-4", cellClass: "w-4" } satisfies ColumnChrome,
      header: () => state.current.selectAll,
      cell: ({ row }) => {
        const task = row.original;
        const current = state.current;
        return (
          <TaskSelectCheckbox
            className="backlog-select-box"
            checked={current.selectedIds.has(task.id)}
            label={current.t("backlog.select_task", { title: task.title })}
            onCheckedChange={() => current.onToggleSelect(task.id)}
          />
        );
      },
    },
    {
      id: "status",
      meta: { headClass: "w-2", cellClass: "w-2" } satisfies ColumnChrome,
      /* Named, not blank: a columnheader with no accessible name leaves the
         cells under it reading as a column of nothing. */
      header: () => <span className="sr-only">{state.current.t("backlog.status")}</span>,
      /* The dot-plus-sr-only grammar AgentStateBadge uses: the shape carries
         a word for anyone who cannot see it. */
      cell: ({ row }) => (
        <>
          <StateMark shape={TASK_STATUS_SHAPE[row.original.status]} />
          <span className="sr-only">{state.current.t(`backlog.statuses.${row.original.status}`)}</span>
        </>
      ),
    },
    {
      id: "title",
      meta: { cellClass: "max-w-md whitespace-normal" } satisfies ColumnChrome,
      header: () => sortHead("title", state.current.t("backlog.col_task")),
      cell: ({ row }) => {
        const task = row.original;
        const current = state.current;
        const { projectName } = current.contextFor(task);
        return (
          <div className="backlog-row-lead-main">
            {/* A real href, so a task can be opened in a new tab or copied;
                a plain click opens the record in place. */}
            <a
              className="backlog-row-title"
              href={hrefForTaskRecord(task.id)}
              onClick={(event) => {
                if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.altKey || event.ctrlKey || event.shiftKey) return;
                event.preventDefault();
                current.onOpenTask(task.id);
              }}
            >{task.title}</a>
            {projectName ? <span className="task-project-label">{projectName}</span> : null}
          </div>
        );
      },
    },
    {
      id: "due",
      meta: { headClass: "task-col-due", cellClass: "task-col-due" } satisfies ColumnChrome,
      header: () => sortHead("due", state.current.t("backlog.due")),
      cell: ({ row }) => {
        const task = row.original;
        const tone = dueTone(task);
        return (
          <span className={cn(tone !== "neutral" && tone)} data-empty={!task.dueDate || undefined}>
            {task.dueDate ? formatDueDate(task.dueDate) : "—"}
          </span>
        );
      },
    },
    {
      id: "assignee",
      meta: { headClass: "task-col-assignee", cellClass: "task-col-assignee" } satisfies ColumnChrome,
      header: () => sortHead("assignee", state.current.t("backlog.assignee")),
      cell: ({ row }) => {
        const task = row.original;
        const context = state.current.contextFor(task);
        return (
          <TaskAssignee
            task={task}
            ready={context.ready}
            agentDisplayName={context.agentDisplayName}
            agentImageUrl={context.agentImageUrl}
          />
        );
      },
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [sort]);
  const table = useReactTable({
    data: tasks,
    columns,
    state: { sorting },
    manualSorting: true,
    getCoreRowModel: getCoreRowModel(),
    getRowId: (task) => task.id,
  });

  return (
    <Table aria-label={t("backlog.title")}>
      <TableHeader>
        {table.getHeaderGroups().map((headerGroup) => (
          <TableRow key={headerGroup.id} className="backlog-rows-head hover:bg-transparent">
            {headerGroup.headers.map((header) => (
              <TableHead
                key={header.id}
                className={(header.column.columnDef.meta as ColumnChrome | undefined)?.headClass}
                aria-sort={sort?.key === header.column.id ? sortIndicator(sort, header.column.id as BacklogSortKey).ariaSort : undefined}
              >
                {flexRender(header.column.columnDef.header, header.getContext())}
              </TableHead>
            ))}
          </TableRow>
        ))}
      </TableHeader>
      <TableBody>
        {table.getRowModel().rows.map((row) => (
          <TableRow
            key={row.id}
            className="backlog-row group"
            data-status={row.original.status}
            data-priority={row.original.priority}
            data-selected={selectedIds.has(row.id) ? "true" : undefined}
          >
            {row.getVisibleCells().map((cell) => (
              <TableCell key={cell.id} className={(cell.column.columnDef.meta as ColumnChrome | undefined)?.cellClass}>
                {flexRender(cell.column.columnDef.cell, cell.getContext())}
              </TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}


/**
 * The exception line: why this task is not simply moving. The derivation is
 * shared (`taskExceptions` in lib/taskExceptions), so the row cannot
 * disagree with the record about whether a task is blocked or why.
 *
 * Nothing to say is nothing to draw: the element used to render empty, and
 * an empty flex row still carries its own margin.
 */
export function TaskFlowDetails({ task, execution }: { task: RelayTaskListItem; execution?: RelaySession["execution"] }) {
  const { t } = useTranslation();
  const exceptions = taskExceptions(task, execution);
  if (exceptions.length === 0) return null;
  return <div className="backlog-meta backlog-flow">
    {exceptions.map((exception) => {
      switch (exception.kind) {
        case "recovering":
          return <span key="recovering" role="status">{t(`thread.execution_${exception.phase}`)}</span>;
        case "blocked": {
          /* An unknown blocker states the recovery copy, not a blank reason —
             it used to print a bare "Blocked:" with nothing after the colon.
             The tooltip carries the reason, which is what a reader hovering a
             truncated line is reaching for. */
          const reason = exception.unknown ? t("recovery.unknown.title") : exception.reason;
          return (
            <span key="blocked" className="backlog-blocker" title={reason || undefined}>
              {reason
                ? `${t("backlog.statuses.blocked")}: ${reason}`
                : t("backlog.statuses.blocked")}
            </span>
          );
        }
        case "waiting":
          return <span key="waiting" className="backlog-due warn">{t("backlog.statuses.waiting_for_human")}</span>;
        case "age":
          return <span key="age" className="tnum">{t("backlog.work_age", { days: exception.days.toFixed(1) })}</span>;
      }
    })}
  </div>;
}
