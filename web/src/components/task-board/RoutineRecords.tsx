"use client";

import { useTranslation } from "react-i18next";
import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ActionCalendar, ActionStart, ICON, NavAgents } from "../icons";
import { PriorityBadge } from "../PriorityBadge";
import { StateMark } from "../StateMark";
import { ROUTINE_STATE_SHAPE, RoutineStateBadge } from "../RoutineStateBadge";
import { TaskAssignee, TaskExecutionBadge } from "../TaskAssignee";
import { TaskSelectCheckbox } from "./TaskSelection";
import { formatNextRunDate } from "./RoutineChrome";
import { routineDueTone, type RoutineState } from "../../lib/routine";
import { hrefForRoute } from "../../lib/appRoute";
import { taskRef } from "../../lib/taskRef";
import { TaskReference } from "./TaskReference";
import { TaskDueCell } from "./TaskDueCell";
import { SortableColumnHeader } from "@/components/ui/SortableColumnHeader";
import type { SortState } from "../../lib/listSort";
import type { ReactNode } from "react";

/** The columns the routine list can order by. Mirrors `routineSortColumns`. */
export type RoutineSortKey = "title" | "state" | "priority" | "assignee" | "nextRun";
import type { RelaySession, RelayTaskListItem } from "../../types";
import { TableCell, TableHead, TableRow } from "@/components/ui/table";

/* One routine, drawn three ways: the board card, the list row, and the meta
   header inside its drawer. Card and row are deliberately the same record in
   two densities — keep their badge order and action group in step.

   The drawer is the exception on default values: it passes `always` to both
   badges, because a record being inspected has to show the value it holds
   even when that value is the default one a scanning surface omits. */

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

export function RoutineCard({
  task,
  state,
  showState = true,
  ready,
  assigneeDisplayName,
  assigneeIsSelf,
  agentDisplayName,
  selected,
  onToggleSelect,
  onEdit,
  onAssign,
  onStart,
  starting,
}: {
  task: RelayTaskListItem;
  state: RoutineState;
  /**
   * False on a board narrowed to ONE schedule state: the section rail beside
   * it has already said which, so the pill would repeat it on every card —
   * the same reason the list rows dropped their state word under a band.
   */
  showState?: boolean;
  ready: boolean;
  assigneeDisplayName?: string;
  assigneeIsSelf?: boolean;
  agentDisplayName?: string;
  selected: boolean;
  onToggleSelect: () => void;
  onEdit: () => void;
  onAssign: () => void;
  onStart: () => void;
  starting: boolean;
}) {
  const { t } = useTranslation();
  const tone = routineDueTone(task);
  const startDisabled = (!task.assignedAgentId && !task.assignedTeamId) || !task.routineEnabled;
  const assigned = Boolean(task.assignedAgentId || task.assignedAgent || task.assignedTeamId);

  // `data-routine-state`, not `data-status`: a routine definition never moves
  // through the board, so its `status` field is a constant and styling on it
  // paints every card the same.
  return (
    <article className="routine-card backlog-task list-virtual" data-priority={task.priority} data-routine-state={state} data-selected={selected ? "true" : undefined}>
      {/* The backlog card's structure, fact for fact: one control gutter, one
          text column, one line of facts, one reserved footer. The two boards
          are one record grammar in two vocabularies — see BacklogTaskCard for
          what each part is for. Both badges stay silent at their default
          value, so a healthy routine renders as a title, a schedule, and
          nothing else. */}
      <div className="backlog-card-head">
        <TaskSelectCheckbox
          className="backlog-select-box"
          checked={selected}
          label={t("routine.select_routine", { title: task.title })}
          onCheckedChange={onToggleSelect}
        />
        <div className="backlog-card-body">
          <Button variant="ghost" type="button" className="backlog-task-title" onClick={onEdit}>{task.title}</Button>
          {task.description ? <p className="backlog-description">{task.description}</p> : null}
          <div className="backlog-meta">
            {showState ? <RoutineStateBadge state={state} /> : null}
            <PriorityBadge priority={task.priority} />
            {assigned ? (
              <span className="backlog-agent">
                <TaskExecutionBadge task={task} ready={ready} displayName={agentDisplayName} />
                {agentDisplayName ? <span className="backlog-agent-name" aria-hidden="true">{agentDisplayName}</span> : null}
              </span>
            ) : null}
            {/* The cadence, and only the cadence. Every routine on this page is
                a task, so the type prefix was a constant printed on every
                card; it survives only for a type that is not the default. */}
            <span className="backlog-cadence">
              {task.routineType && task.routineType !== "task"
                ? `${t(`routine.types.${task.routineType}`)} · ${t(`routine.cadences.${task.routineCadence ?? "weekly"}`)}`
                : t(`routine.cadences.${task.routineCadence ?? "weekly"}`)}
            </span>
            {assigneeIsSelf ? null : (
              <TaskAssignee task={task} ready={ready} assigneeDisplayName={assigneeDisplayName} agentDisplayName={agentDisplayName} unassignedLabel={t("backlog.unassigned")} showAgent={false} />
            )}
            {task.routineNextRunDate ? (
              <span className={cn("backlog-due", tone !== "neutral" && tone)}>
                <ActionCalendar size={ICON.sm} />
                {formatNextRunDate(task.routineNextRunDate)}
              </span>
            ) : null}
          </div>
          <div className="backlog-card-foot">
            <TaskReference taskId={task.id} />
            <div className="backlog-task-actions" role="group" aria-label={t("backlog.actions")}>
              <div className="backlog-action-group" role="group" aria-label={t("backlog.actions_dispatch")}>
                <RoutineAssignButton onAssign={onAssign} />
                <RoutineStartButton disabled={startDisabled} onStart={onStart} starting={starting} />
              </div>
            </div>
          </div>
        </div>
      </div>
    </article>
  );
}

/**
 * The routine list's column header row, rendered once above every group —
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
      <TableHead className="backlog-rows-head-cell backlog-rows-head-dot" />
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
  session,
  ready,
  assigneeDisplayName,
  assigneeIsSelf,
  agentDisplayName,
  selected,
  onToggleSelect,
  onEdit,
  onAssign,
  onStart,
  starting,
}: {
  task: RelayTaskListItem;
  state: RoutineState;
  session?: RelaySession;
  ready: boolean;
  assigneeDisplayName?: string;
  assigneeIsSelf?: boolean;
  agentDisplayName?: string;
  selected: boolean;
  onToggleSelect: () => void;
  onEdit: () => void;
  onAssign: () => void;
  onStart: () => void;
  starting: boolean;
}) {
  const { t } = useTranslation();
  const tone = routineDueTone(task);
  const startDisabled = (!task.assignedAgentId && !task.assignedTeamId) || !task.routineEnabled;
  const assigned = Boolean(task.assignedAgentId || task.assignedAgent || task.assignedTeamId);

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
      <span className="backlog-row-dot-cell" aria-hidden="true">
        <StateMark shape={ROUTINE_STATE_SHAPE[state]} />
      </span>
      <TableCell className="backlog-row-ref code">{taskRef(task.id)}</TableCell>
      <TableCell render={<div />} className="backlog-row-lead">
        <Button variant="ghost" type="button" className="backlog-row-title" onClick={onEdit}>{task.title}</Button>
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
        <TaskAssignee task={task} ready={ready} assigneeDisplayName={assigneeDisplayName} assigneeIsSelf={assigneeIsSelf} agentDisplayName={agentDisplayName} unassignedLabel={t("backlog.unassigned")} />
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

export function RoutineDrawerMeta({
  task,
  state,
  session,
  onOpenThread,
}: {
  task: RelayTaskListItem;
  state: RoutineState;
  session?: RelaySession;
  onOpenThread: (sessionId: string) => void;
}) {
  const { t } = useTranslation();
  const lastActivity = task.lastActivity;

  return (
    <section className="task-drawer-meta" aria-label={t("routine.meta")}>
      <div className="task-drawer-meta-row">
        <RoutineStateBadge state={state} always />
        {session ? (
          <a
            data-slot="link-button"
            href={hrefForRoute("main", session.id)}
            className={buttonVariants({ variant: "ghost", size: "sm" })}
            onClick={(event) => {
              if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.altKey || event.ctrlKey || event.shiftKey) return;
              event.preventDefault();
              onOpenThread(session.id);
            }}
          >
            {t("backlog.open_thread")}
          </a>
        ) : null}
      </div>
      <p className="task-drawer-meta-activity">
        {lastActivity ? lastActivity.message : t("routine.no_activity")}
      </p>
    </section>
  );
}
