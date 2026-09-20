"use client";

import { type DragEvent, type ReactNode, type TouchEvent } from "react";
import { useTranslation } from "react-i18next";
import { PriorityBadge } from "../PriorityBadge";
import { cn } from "@/lib/utils";
import { type RelaySession, type RelayTaskListItem } from "../../types";
import {
  ActionApprove,
  ActionCalendar,
  ActionStart,
  ActionStop,
  ICON,
  NavAgents,
  NavRefresh,
} from "../icons";
import { dueTone } from "../../lib/backlog";
import { taskResultLine } from "../../lib/taskResult";
import { taskExceptions, taskWorkAgeDays } from "../../lib/taskExceptions";
import { RoutineOriginBadge } from "./RoutineOriginBadge";
import { taskRef } from "../../lib/taskRef";
import { pathForAppState } from "../../lib/appRoute";

export function hrefForTaskRecord(taskId: string): string {
  return pathForAppState({ route: "backlog", mobileView: "chat", sessionId: null, taskId });
}
import { TaskAssignee, TaskExecutionBadge } from "../TaskAssignee";
import { Button } from "@/components/ui/button";
import { StateMark } from "../StateMark";
import { SortableColumnHeader } from "@/components/ui/SortableColumnHeader";
import type { SortState } from "../../lib/listSort";

/** The columns the backlog list can order by. Mirrors `backlogSortColumns`. */
export type BacklogSortKey = "title" | "status" | "priority" | "assignee" | "due";

import { TaskSelectCheckbox } from "./TaskSelection";
import { TASK_STATUS_SHAPE } from "./backlogVocabulary";
import { formatDueDate } from "./BacklogChrome";
import { TaskDueCell } from "./TaskDueCell";
import { TableCell, TableHead, TableRow } from "@/components/ui/table";

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
  assigneeDisplayName,
  assigneeIsSelf,
  agentDisplayName,
  selected,
  onToggleSelect,
  dragging,
  onDragStart,
  onDragEnd,
  onTouchStart,
  onOpen,
}: {
  task: RelayTaskListItem;
  projectName?: string;
  ready: boolean;
  assigneeDisplayName?: string;
  assigneeIsSelf?: boolean;
  agentDisplayName?: string;
  selected: boolean;
  onToggleSelect: () => void;
  dragging: boolean;
  onDragStart: (event: DragEvent<HTMLElement>) => void;
  onDragEnd: () => void;
  onTouchStart: (event: TouchEvent<HTMLElement>) => void;
  /** Opens the record drawer. The title is a destination now, not a form. */
  onOpen: () => void;
}) {
  const { t } = useTranslation();
  const tone = dueTone(task);
  const age = taskWorkAgeDays(task);
  // Nothing is assigned yet: the empty dashed slot said so with a glyph that
  // named nobody, on the one lane where unassigned is the normal condition.
  const assigned = Boolean(task.assignedAgentId || task.assignedAgent || task.assignedTeamId);

  return (
    <article
      className="backlog-task group list-virtual"
      data-priority={task.priority}
      data-selected={selected ? "true" : undefined}
      data-dragging={dragging ? "true" : undefined}
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onTouchStart={onTouchStart}
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
            {assigned ? (
              <span className="backlog-agent">
                <TaskExecutionBadge task={task} ready={ready} displayName={agentDisplayName} />
                {/* The badge already announces "<name> · <availability>" to
                    assistive tech; this is the same string made visible. */}
                {agentDisplayName ? <span className="backlog-agent-name" aria-hidden="true">{agentDisplayName}</span> : null}
              </span>
            ) : null}
            {assigneeIsSelf ? null : (
              <TaskAssignee task={task} ready={ready} assigneeDisplayName={assigneeDisplayName} agentDisplayName={agentDisplayName} unassignedLabel={t("backlog.unassigned")} showAgent={false} />
            )}
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
/**
 * The column header row — rendered ONCE, above every group.
 *
 * It used to repeat per group, on the reasoning that a band interrupts the
 * columns and a header six bands up stops naming the row under the eye. What
 * that reasoning missed is the cost at the density these lists actually run
 * at: four routine groups meant four band slabs and four identical header
 * rows for six records, so the page read as four small tables rather than
 * one list, and the furniture outweighed the content. One header, made
 * sticky so it stays over the rows it names, answers the original concern
 * without spending a row of chrome per group. The bands go quiet to match
 * (see .list-group-band) — they name the group, they no longer restart it.
 */
export function BacklogRowsHead({
  sort,
  onSort,
  selectAll,
}: {
  sort: SortState<BacklogSortKey> | null;
  onSort: (key: BacklogSortKey) => void;
  selectAll: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <TableRow className="backlog-rows-head">
      <TableHead className="backlog-rows-head-cell backlog-rows-head-select">{selectAll}</TableHead>
      {/* Named, not blank: a columnheader with no accessible name leaves the
          cells under it reading as a column of nothing. */}
      <TableHead className="backlog-rows-head-cell backlog-rows-head-dot">
        <span className="sr-only">{t("backlog.status")}</span>
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
        label={t("backlog.due")}
        sortKey="due"
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
      {/* Actions is not a column of data — there is nothing to order by. */}
      <TableHead className="backlog-rows-head-cell backlog-rows-head-actions">{t("backlog.actions")}</TableHead>
    </TableRow>
  );
}

export function BacklogTaskRow({
  task,
  projectName,
  session,
  routineTitle,
  ready,
  assigneeDisplayName,
  assigneeIsSelf,
  agentDisplayName,
  canDiscuss,
  selected,
  onToggleSelect,
  onOpen,
  onEdit,
  onAssign,
  onStart,
  starting,
  onToggleBlock,
  onDone,
}: {
  task: RelayTaskListItem;
  projectName?: string;
  session?: RelaySession;
  /** Title of the routine this task was promoted from, when it was. */
  routineTitle?: string;
  ready: boolean;
  assigneeDisplayName?: string;
  assigneeIsSelf?: boolean;
  agentDisplayName?: string;
  canDiscuss: boolean;
  selected: boolean;
  onToggleSelect: () => void;
  /** Opens the task's record. The title is a destination now, not a form. */
  onOpen: () => void;
  onEdit: () => void;
  onAssign: () => void;
  onStart: () => void;
  starting: boolean;
  onToggleBlock: () => void;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const tone = dueTone(task);
  const result = taskResultLine(task, session);
  // Nothing is assigned yet: the empty dashed slot said so with a glyph that
  // named nobody, on the one lane where unassigned is the normal condition.
  // The assign action is two icons away.
  const assigned = Boolean(task.assignedAgentId || task.assignedAgent || task.assignedTeamId);
  const startDisabled =
    (!task.assignedAgentId && !task.assignedTeamId && !canDiscuss) ||
    task.status === "running" ||
    task.status === "done";

  return (
    <TableRow render={<article />} className="backlog-row group list-virtual" data-status={task.status} data-priority={task.priority} data-selected={selected ? "true" : undefined}>
      <TableCell className="backlog-row-select-cell">
        <TaskSelectCheckbox
          className="backlog-select-box"
          checked={selected}
          label={t("backlog.select_task", { title: task.title })}
          onCheckedChange={onToggleSelect}
        />
      </TableCell>
      {/* A cell, so the row has exactly as many cells as the header has
          columns, and the shape carries a word for anyone who cannot see it —
          the same dot-plus-sr-only grammar AgentStateBadge uses. */}
      <TableCell className="backlog-row-dot-cell">
        <StateMark shape={TASK_STATUS_SHAPE[task.status]} />
        <span className="sr-only">{t(`backlog.statuses.${task.status}`)}</span>
      </TableCell>
      <TableCell className="backlog-row-ref code">{taskRef(task.id)}</TableCell>
      <TableCell render={<div />} className="backlog-row-lead">
        <a
          className="backlog-row-title"
          href={hrefForTaskRecord(task.id)}
          onClick={(event) => {
            if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.altKey || event.ctrlKey || event.shiftKey) return;
            event.preventDefault();
            onOpen();
          }}
        >{task.title}</a>
        {projectName ? <span className="task-project-label">{projectName}</span> : null}
        <TaskFlowDetails task={task} execution={session?.execution} />
        <RoutineOriginBadge task={task} routineTitle={routineTitle} />
      </TableCell>
      <TableCell render={<div />} className="backlog-row-tags">
        <PriorityBadge priority={task.priority} />
      </TableCell>
      <TableCell className="backlog-row-due">
        <TaskDueCell
          date={task.dueDate}
          tone={tone}
          format={formatDueDate}
          emptyLabel={t("backlog.add_due")}
          onEdit={onEdit}
        />
        {/* Files rode in a labelled RESULT column of their own, which stood
            empty on nearly every row — a named column for a fact most rows
            do not have. The count is a footnote to the date the run finished
            against, so it trails it instead. */}
        {result?.hasFiles ? (
          <span className="backlog-row-files tnum">
            {t("backlog.result_files", { count: result.fileCount })}
          </span>
        ) : null}
      </TableCell>
      <TableCell className="backlog-row-assignee">
        <TaskAssignee task={task} ready={ready} assigneeDisplayName={assigneeDisplayName} assigneeIsSelf={assigneeIsSelf} agentDisplayName={agentDisplayName} unassignedLabel={t("backlog.unassigned")} />
      </TableCell>
      <TableCell render={<div />} className="backlog-row-actions" aria-label={t("backlog.actions")}>
        <div className="backlog-action-group" role="group" aria-label={t("backlog.actions_dispatch")}>
          <Button variant="outline"
            type="button"
            className="backlog-action-icon"
            onClick={onAssign}
            disabled={task.status === "running" || task.status === "done"}
            aria-label={t("backlog.assign_task")}
            title={t("backlog.assign_task")}
          >
            <NavAgents size={ICON.sm} />
          </Button>
          {/* The tinted icon, not the filled default the card uses — see the
              note on .backlog-row-actions. */}
          <Button variant="icon"
            size="icon-dense"
            tinted
            type="button"
            className="backlog-action-primary backlog-action-icon"
            onClick={onStart}
            disabled={startDisabled}
            loading={starting}
            aria-label={task.status === "blocked" ? t("backlog.retry") : ["review", "waiting_for_human"].includes(task.status) ? t("backlog.rework") : (task.assignedAgentId || task.assignedTeamId) ? t("backlog.start") : t("backlog.start_team")}
            title={task.status === "blocked" ? t("backlog.retry") : ["review", "waiting_for_human"].includes(task.status) ? t("backlog.rework") : (task.assignedAgentId || task.assignedTeamId) ? t("backlog.start") : t("backlog.start_team")}
          >
            <ActionStart size={ICON.sm} />
          </Button>
        </div>
        <div className="backlog-action-group" role="group" aria-label={t("backlog.actions_state")}>
          <Button variant="outline"
            type="button"
            className={cn("backlog-action-icon", task.status !== "blocked" && "backlog-action-block")}
            onClick={onToggleBlock}
            disabled={task.status === "running" || task.status === "done"}
            aria-label={task.status === "blocked" ? t("backlog.unblock") : t("backlog.block")}
            title={task.status === "blocked" ? t("backlog.unblock") : t("backlog.block")}
          >
            {task.status === "blocked" ? <NavRefresh size={ICON.sm} /> : <ActionStop size={ICON.sm} />}
          </Button>
          <Button variant="outline"
            type="button"
            className="backlog-action-icon backlog-action-done"
            onClick={onDone}
            disabled={task.status !== "review"}
            aria-label={t("backlog.done")}
            title={t("backlog.done")}
          >
            <ActionApprove size={ICON.sm} />
          </Button>
        </div>
      </TableCell>
    </TableRow>
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
