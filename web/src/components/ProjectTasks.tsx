"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
} from "@tanstack/react-table";
import { useRelayMutations } from "../hooks/useRelayMutations";
import { projectTaskProgress, projectTaskQueue } from "../lib/projectTasks";
import { taskCreateIntent } from "../lib/taskCreateIntent";
import { projectReadOnly } from "../lib/projectPage";
import {
  agentReadyForTask,
  backlogSortColumns,
  dueTone,
  filterTasks,
  TASK_STATUSES,
  type BacklogFilters,
  type BacklogSortKey,
} from "../lib/backlog";
import { taskAgentDisplayName, taskAssigneeLabel, teamReady } from "../lib/taskAssignment";
import { taskStartMutationInput } from "../lib/taskBoardForm";
import { applySort, nextSortState, sortIndicator, type SortState } from "../lib/listSort";
import { cn } from "@/lib/utils";
import type { AgentTeam, EmployeeAgent, ProjectRecord, RelayTaskListItem } from "../types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { SortColumnButton } from "@/components/ui/SortableColumnHeader";
import { StateMark } from "./StateMark";
import { PriorityBadge } from "./PriorityBadge";
import { TaskAssignee } from "./TaskAssignee";
import { BoardEmpty } from "./BoardEmpty";
import { BacklogFiltersBar, formatDueDate } from "./task-board/BacklogChrome";
import { activeFilterCount, initialFilters, TASK_STATUS_SHAPE } from "./task-board/backlogVocabulary";

/** Per-column element classes, carried through TanStack's open `meta` slot. */
type ColumnChrome = { headClass?: string; cellClass?: string };

/**
 * A project's tasks as one filtered, sortable list.
 *
 * The lanes used to live here too, but the tasks page already owns the board;
 * duplicating it gave the same queue two drag surfaces that could disagree.
 * What the project needs answered is "what is on this project, and in what
 * state" — a list says that better than five thin columns, and the backlog's
 * own filter vocabulary (`filterTasks`, `BacklogFiltersBar`) keeps the two
 * surfaces reading the same record the same way.
 *
 * TanStack owns the table model (columns, rows, sorting state) and renders
 * through the shadcn table. Sorting stays MANUAL: the backlog's ordering
 * rules (undated and unassigned rows sink in BOTH directions) live in
 * `applySort`/`backlogSortColumns`, and a library sortingFn — inverted whole
 * for descending — cannot express that, so the table consumes rows already
 * ordered and only tracks which column the reader asked for.
 */
export function ProjectTasks({ project, tasks, agents, teams, onOpenRecord }: {
  project: ProjectRecord;
  tasks: RelayTaskListItem[];
  agents: EmployeeAgent[];
  teams: AgentTeam[];
  /** Opens the task's record as a drawer over this project. */
  onOpenRecord: (taskId: string) => void;
}) {
  const { t } = useTranslation();
  const { createTaskMutation, updateTaskMutation, startTaskMutation } = useRelayMutations();
  const inputRef = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState("");
  const pendingActions = useRef(new Set<string>());
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  /* Errors are keyed by the action that raised them, so a failed Start on the
     fifth row reports on that row instead of at the top of the panel. */
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [filters, setFilters] = useState<BacklogFilters>(initialFilters);
  const [sorting, setSorting] = useState<SortingState>([]);
  const readOnly = projectReadOnly(project);
  const work = useMemo(() => projectTaskQueue(tasks, project.id), [tasks, project.id]);
  /* A project's tasks have no status rail, so status is a chip in the bar. */
  const statusFilter = useMemo(() => ({
    field: {
      id: "status",
      label: t("backlog.status"),
      kind: "select" as const,
      options: TASK_STATUSES.map((status) => ({ value: status, label: t(`backlog.statuses.${status}`) })),
    },
    value: filters.status === "all" ? "" : filters.status,
    onChange: (status: string) => setFilters((current) => ({ ...current, status: (status || "all") as BacklogFilters["status"] })),
  }), [filters.status, t]);
  const progress = projectTaskProgress(work);
  const canStart = project.members.some((member) => member.enabled);
  /* flexRender mounts a column's cell function AS a component, so a column
     def that closes over render-volatile values — `busy`/`errors` on every
     action, `t` and the caller's inline `onOpenRecord` on every parent
     render — would unmount and remount every cell subtree each time. The
     column defs below therefore stay stable across those values and read
     them through this ref at render time. Declared before `sortColumns`:
     the label resolver dereferences it during `rows` computation. */
  const actionState = useRef({ busy, errors, t, onOpenRecord, startTaskMutation, updateTaskMutation });
  actionState.current = { busy, errors, t, onOpenRecord, startTaskMutation, updateTaskMutation };
  /* The label resolver reads `t` through that ref rather than closing over
     it: a `t` identity that changes per render would otherwise make
     `sortColumns` — and with it `rows`, the table's `data` — a new reference
     on every render, which loops TanStack's row model. */
  const sortColumns = useMemo(
    () => backlogSortColumns((task) => taskAssigneeLabel(task, taskAgentDisplayName(task, agents, teams), (key) => actionState.current.t(key))),
    [agents, teams],
  );
  const sort: SortState<BacklogSortKey> | null = sorting[0]
    ? { key: sorting[0].id as BacklogSortKey, direction: sorting[0].desc ? "desc" : "asc" }
    : null;
  /* Sort applies AFTER filtering, over the queue order `filterTasks` produces;
     with no column chosen `applySort` is the identity and that considered
     default (priority, then due date, then recency) survives untouched. */
  const rows = useMemo(() => applySort(filterTasks(work, filters), sortColumns, sort), [work, filters, sort, sortColumns]);
  const filtered = activeFilterCount(filters) > 0 || filters.query.trim().length > 0;

  useEffect(() => {
    const channel = taskCreateIntent();
    if (!channel) return;
    let frame = 0;
    const focus = () => {
      if (channel.consume()) frame = requestAnimationFrame(() => inputRef.current?.focus());
    };
    focus();
    const unsubscribe = channel.subscribe(focus);
    return () => { unsubscribe(); cancelAnimationFrame(frame); };
  }, []);

  // Keep each action locked until its own request settles.
  async function perform(key: string, action: () => Promise<unknown>) {
    if (pendingActions.current.has(key) || readOnly) return;
    pendingActions.current.add(key);
    setBusy(new Set(pendingActions.current));
    setErrors((current) => {
      const { [key]: _cleared, ...rest } = current;
      return rest;
    });
    try { await action(); }
    catch (cause) {
      const message = cause instanceof Error ? cause.message : t("errors.save_task");
      setErrors((current) => ({ ...current, [key]: message }));
    }
    finally {
      pendingActions.current.delete(key);
      setBusy(new Set(pendingActions.current));
    }
  }

  function create(event: FormEvent) {
    event.preventDefault();
    if (!title.trim()) return;
    void perform("create", async () => {
      await createTaskMutation.mutateAsync({ title: title.trim(), projectId: project.id, status: "backlog" });
      setTitle("");
    });
  }

  /* TanStack's own toggle cycles asc → desc → none with no notion of a
     column's OPENING direction; `nextSortState` is the cycle the other lists
     already speak (unsorted → the column's default → reversed → unsorted), so
     the header behaves identically here and on the backlog. */
  function toggleSort(key: BacklogSortKey) {
    setSorting((current) => {
      const currentSort: SortState<BacklogSortKey> | null = current[0]
        ? { key: current[0].id as BacklogSortKey, direction: current[0].desc ? "desc" : "asc" }
        : null;
      const next = nextSortState(currentSort, key, sortColumns);
      return next ? [{ id: next.key, desc: next.direction === "desc" }] : [];
    });
  }

  function sortHead(key: BacklogSortKey, label: string): ReactNode {
    const { active, direction } = sortIndicator(sort, key);
    return (
      <SortColumnButton
        label={label}
        sortKey={key}
        onSort={toggleSort}
        align="start"
        active={active}
        direction={direction}
      />
    );
  }

  const columns = useMemo<ColumnDef<RelayTaskListItem>[]>(() => {
    const defs: ColumnDef<RelayTaskListItem>[] = [
      {
        id: "status",
        meta: { headClass: "w-8", cellClass: "w-8 pr-0" } satisfies ColumnChrome,
        /* Named, not blank: a columnheader with no accessible name leaves the
           cells under it reading as a column of nothing. */
        header: () => <span className="sr-only">{actionState.current.t("backlog.status")}</span>,
        /* The status word already rides beside the title, visible — a second
           sr-only copy here would read every row's status twice. */
        cell: ({ row }) => <StateMark shape={TASK_STATUS_SHAPE[row.original.status]} />,
      },
      {
        id: "title",
        meta: { cellClass: "max-w-md whitespace-normal" } satisfies ColumnChrome,
        header: () => sortHead("title", actionState.current.t("backlog.col_task")),
        cell: ({ row }) => {
          const task = row.original;
          return (
            <>
              <div className="project-task-lead">
                {/* The record opens over the project, not by leaving for the
                    backlog board — the project stays the reader's place. The
                    status word rides beside the title: a flat list, unlike a
                    lane, still needs it spelled out. */}
                <button
                  type="button"
                  className="project-task-title"
                  title={task.title}
                  onClick={() => actionState.current.onOpenRecord(task.id)}
                >
                  {task.title}
                </button>
                <span className="task-project-label">{actionState.current.t(`backlog.statuses.${task.status}`)}</span>
              </div>
              {actionState.current.errors[task.id] ? <p role="alert" className="project-task-failure">{actionState.current.errors[task.id]}</p> : null}
            </>
          );
        },
      },
      {
        id: "priority",
        header: () => sortHead("priority", actionState.current.t("backlog.priority")),
        cell: ({ row }) => <PriorityBadge priority={row.original.priority} />,
      },
      {
        id: "due",
        header: () => sortHead("due", actionState.current.t("backlog.due")),
        cell: ({ row }) => {
          const task = row.original;
          const tone = dueTone(task);
          return (
            <span className={cn("backlog-due-value", tone !== "neutral" && tone)} data-empty={!task.dueDate || undefined}>
              {task.dueDate ? formatDueDate(task.dueDate) : "—"}
            </span>
          );
        },
      },
      {
        id: "assignee",
        header: () => sortHead("assignee", actionState.current.t("backlog.assignee")),
        cell: ({ row }) => {
          const task = row.original;
          /* A team dispatches through its lead, so a task carrying both is
             the team's. */
          const team = teams.find((candidate) => candidate.id === task.assignedTeamId);
          return (
            <TaskAssignee
              task={task}
              ready={team ? teamReady(team) : agentReadyForTask(task, [], agents)}
              agentDisplayName={taskAgentDisplayName(task, agents, teams)}
              agentImageUrl={team ? team.profileImageUrl : agents.find((agent) => agent.id === task.assignedAgentId)?.profileImageUrl ?? null}
            />
          );
        },
      },
    ];
    /* Actions is not a column of data — there is nothing to order by, and a
       read-only project has nothing to do. */
    if (!readOnly) {
      defs.push({
        id: "actions",
        meta: { headClass: "text-right", cellClass: "text-right" } satisfies ColumnChrome,
        header: () => actionState.current.t("backlog.actions"),
        cell: ({ row }) => {
          const task = row.original;
          const pending = actionState.current.busy.has(task.id);
          const say = actionState.current.t;
          return (
            <>
              {(task.status === "backlog" || task.status === "assigned") ? (
                <Button type="button" variant="outline" size="dense"
                  loading={pending} disabled={pending || !canStart}
                  tooltip={!canStart ? say("project.tasks_add_team") : undefined}
                  onClick={() => void perform(task.id, () => actionState.current.startTaskMutation.mutateAsync(taskStartMutationInput(task)))}>
                  {say("project.tasks_start")}
                </Button>
              ) : null}
              {task.status === "review" ? (
                <Button type="button" variant="outline" size="dense"
                  loading={pending} disabled={pending}
                  onClick={() => void perform(task.id, () => actionState.current.updateTaskMutation.mutateAsync({ taskId: task.id, input: { status: "done" } }))}>
                  {say("project.tasks_accept")}
                </Button>
              ) : null}
            </>
          );
        },
      });
    }
    return defs;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sort, readOnly, canStart, agents, teams]);
  const table = useReactTable({
    data: rows,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    manualSorting: true,
    getCoreRowModel: getCoreRowModel(),
    getRowId: (task) => task.id,
  });

  return (
    <div className="project-tasks">
      <section className="project-task-summary" aria-label={t("project.tasks_progress")}>
        <div>
          <span className="project-task-eyebrow">{t("project.tasks_progress")}</span>
          <strong className="project-task-completion">{progress.done}<span> / {progress.total}</span></strong>
          <p>{t("project.tasks_completed")}</p>
        </div>
        <div className="project-task-progress-copy">
          <p>{progress.total ? t("project.tasks_progress_hint") : t("project.tasks_empty_hint")}</p>
          <div className="project-task-progress" role="progressbar" aria-label={t("project.tasks_progress")}
            aria-valuemin={0} aria-valuemax={progress.total || 1} aria-valuenow={progress.done}>
            <span style={{ width: `${progress.percent}%` }} />
          </div>
          {progress.attention > 0 ? (
            <span className="project-task-attention">
              <StateMark shape={TASK_STATUS_SHAPE.blocked} />
              {t("project.tasks_attention", { count: progress.attention })}
            </span>
          ) : null}
        </div>
      </section>
      {!readOnly ? (
        <form className="project-task-create" onSubmit={create}>
          <Input ref={inputRef} aria-label={t("backlog.new_task")} placeholder={t("project.tasks_placeholder")}
            maxLength={500} value={title} disabled={busy.has("create")} onChange={(event) => setTitle(event.target.value)} />
          <Button type="submit" loading={busy.has("create")} disabled={busy.has("create") || !title.trim()}>{t("backlog.new_task")}</Button>
        </form>
      ) : null}
      {errors.create ? <p role="alert" className="project-task-failure">{errors.create}</p> : null}
      {work.length ? (
        <BacklogFiltersBar
          filters={filters}
          agents={agents}
          teams={teams}
          onChange={setFilters}
          extraField={statusFilter}
        />
      ) : null}
      {rows.length === 0 ? (
        <BoardEmpty
          title={filtered ? t("backlog.no_match_title") : t("backlog.no_tasks_title")}
          body={filtered ? t("backlog.no_match_body") : t("backlog.no_tasks_body")}
          clearLabel={filtered ? t("backlog.clear_filters") : undefined}
          onClear={filtered ? () => setFilters(initialFilters) : undefined}
        />
      ) : (
        <Table aria-label={t("project.tasks_tab")}>
          <TableHeader>
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id} className="hover:bg-transparent">
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
              <TableRow key={row.id} data-status={row.original.status}>
                {row.getVisibleCells().map((cell) => (
                  <TableCell key={cell.id} className={(cell.column.columnDef.meta as ColumnChrome | undefined)?.cellClass}>
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
