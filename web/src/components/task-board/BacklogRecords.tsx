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
import { RoutineOriginBadge } from "./RoutineOriginBadge";
import { taskRef } from "../../lib/taskRef";
import { TaskReference } from "./TaskReference";
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
  session,
  routineTitle,
  ready,
  assigneeDisplayName,
  assigneeIsSelf,
  agentDisplayName,
  canDiscuss,
  selected,
  onToggleSelect,
  dragging,
  onDragStart,
  onDragEnd,
  onTouchStart,
  onEdit,
  onAssign,
  onStart,
  starting,
  onToggleBlock,
  onDone,
}: {
  task: RelayTaskListItem;
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
  dragging: boolean;
  onDragStart: (event: DragEvent<HTMLElement>) => void;
  onDragEnd: () => void;
  onTouchStart: (event: TouchEvent<HTMLElement>) => void;
  onEdit: () => void;
  onAssign: () => void;
  onStart: () => void;
  starting: boolean;
  onToggleBlock: () => void;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const tone = dueTone(task);
  const startDisabled =
    (!task.assignedAgentId && !task.assignedTeamId && !canDiscuss) ||
    task.status === "running" ||
    task.status === "done";
  const result = taskResultLine(task, session);
  const age = workAgeDays(task);
  // Nothing is assigned yet: the empty dashed slot said so with a glyph that
  // named nobody, on the one lane where unassigned is the normal condition.
  // The assign action is two icons away.
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
      {/* One text column. The checkbox holds the card's control gutter — a
          selection control that moves with the content is unusable — and
          everything that is not the checkbox (title, description, facts,
          footer) lines up on a single left edge. The description used to
          start at the card's padding edge while the title started 24px in,
          so every card with a description read as two misaligned blocks. */}
      <div className="backlog-card-head">
        <TaskSelectCheckbox
          className="backlog-select-box"
          checked={selected}
          label={t("backlog.select_task", { title: task.title })}
          onCheckedChange={onToggleSelect}
        />
        <div className="backlog-card-body">
          <Button variant="ghost" type="button" className="backlog-task-title" onClick={onEdit}>{task.title}</Button>
          <TaskFlowDetails task={task} execution={session?.execution} showAge={false} />
          {task.description ? <p className="backlog-description">{task.description}</p> : null}
          {/* One line of facts, and only facts the lane above does not already
              state. What used to be here and is gone: the task's status word
              (the lane IS the status — `taskResultLine.status` is literally
              `task.status`), and "No due date" on every undated card, which
              spent a fact slot announcing that nobody had decided anything.
              The agent gained its name: a bare executor glyph identified
              nothing on a card with room to spell it. */}
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
            <RoutineOriginBadge task={task} routineTitle={routineTitle} />
            {assigneeIsSelf ? null : (
              <TaskAssignee task={task} ready={ready} assigneeDisplayName={assigneeDisplayName} agentDisplayName={agentDisplayName} unassignedLabel={t("backlog.unassigned")} showAgent={false} />
            )}
            {task.dueDate ? (
              <span className={cn("backlog-due", tone !== "neutral" && tone)}>
                <ActionCalendar size={ICON.sm} />
                {formatDueDate(task.dueDate)}
              </span>
            ) : null}
            {result?.hasFiles ? (
              <span className="backlog-result-files tnum">
                {t("backlog.result_files", { count: result.fileCount })}
              </span>
            ) : null}
          </div>
          {/* A reserved footer row, not an overlay. The action bar used to be
              absolutely positioned across the card's bottom edge, so hovering
              a card covered its own meta line — every fact the reader was
              scanning disappeared under the buttons that appeared because
              they moved the pointer there. The row is always laid out; the
              only thing the actions cover is the reference, which is an
              address the drawer and the list column both still carry. */}
          <div className="backlog-card-foot">
            <TaskReference taskId={task.id} />
            <div className="backlog-task-actions" role="group" aria-label={t("backlog.actions")}>
              {/* Four glyphs of one weight, labels in the tooltip. The card
                  used to spell "Block" and "Done" as text buttons beside two
                  icons — four controls in two shapes, which wrapped the bar
                  onto a second line inside a lane-width card. They are all the
                  quiet `icon` tier now and each lights up in its own meaning
                  on hover: action for start, --err for block, --ok for done —
                  the same two rules the list rows use. */}
              <div className="backlog-action-group" role="group" aria-label={t("backlog.actions_dispatch")}>
                <Button variant="icon"
                  size="icon-dense"
                  type="button"
                  className="backlog-action-icon"
                  onClick={onAssign}
                  disabled={task.status === "running" || task.status === "done"}
                  aria-label={t("backlog.assign_task")}
                  title={t("backlog.assign_task")}
                >
                  <NavAgents size={ICON.sm} />
                </Button>
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
                <Button variant="icon"
                  size="icon-dense"
                  type="button"
                  className={cn("backlog-action-icon", task.status !== "blocked" && "backlog-action-block")}
                  onClick={onToggleBlock}
                  disabled={task.status === "running" || task.status === "done"}
                  aria-label={task.status === "blocked" ? t("backlog.unblock") : t("backlog.block")}
                  title={task.status === "blocked" ? t("backlog.unblock") : t("backlog.block")}
                >
                  {task.status === "blocked" ? <NavRefresh size={ICON.sm} /> : <ActionStop size={ICON.sm} />}
                </Button>
                <Button variant="icon"
                  size="icon-dense"
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
            </div>
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
  session,
  routineTitle,
  ready,
  assigneeDisplayName,
  assigneeIsSelf,
  agentDisplayName,
  canDiscuss,
  selected,
  onToggleSelect,
  onEdit,
  onAssign,
  onStart,
  starting,
  onToggleBlock,
  onDone,
}: {
  task: RelayTaskListItem;
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
        <Button variant="ghost" type="button" className="backlog-row-title" onClick={onEdit}>{task.title}</Button>
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

/** Days since the task started, for work still in flight. */
function workAgeDays(task: RelayTaskListItem): number | null {
  if (!task.startedAt || task.status === "done") return null;
  return Math.max(0, (Date.now() - Date.parse(task.startedAt)) / 86400000);
}

/**
 * The exception line: why this task is not simply moving. `showAge` is false
 * on the card, where the work age belongs to the facts line instead — the
 * card is a fixed frame and an exception that spans two rows was clipping its
 * own second row in half.
 */
function TaskFlowDetails({ task, execution, showAge = true }: { task: RelayTaskListItem; execution?: RelaySession["execution"]; showAge?: boolean }) {
  const { t } = useTranslation();
  const age = showAge ? workAgeDays(task) : null;
  // Nothing to say is nothing to draw. The element used to render empty, and
  // an empty flex row still carries its own margin — 12px of nowhere on every
  // card that was neither blocked, waiting, nor in flight.
  const blocker = task.attention?.evidence === "unknown" || task.blockerReason === "Execution needs attention."
    ? t("recovery.unknown.title") : task.attention?.summary || task.blockerReason;
  const recovering = execution && !["running", "terminal"].includes(execution.phase);
  if (!recovering && task.status !== "blocked" && task.status !== "waiting_for_human" && age === null) return null;
  return <div className="backlog-meta backlog-flow">
    {recovering ? <span role="status">{t(`thread.execution_${execution.phase}`)}</span> : null}
    {/* The reason is one line on the card and the full text in the drawer —
        a three-line blocker used to push the card's own action row out
        through the bottom edge. A blocker with no reason recorded states the
        word alone; it used to print a bare "Blocked:" with nothing after the
        colon. The tooltip carries the reason, which is what a reader hovering
        a truncated line is reaching for — who blocked it and when are facts
        the drawer states in full. */
    task.status === "blocked" ? (
      <span className="backlog-blocker" title={blocker || undefined}>
        {blocker
          ? `${t("backlog.statuses.blocked")}: ${blocker}`
          : t("backlog.statuses.blocked")}
      </span>
    ) : null}
    {task.status === "waiting_for_human" ? <span className="backlog-due warn">{t("backlog.statuses.waiting_for_human")}</span> : null}
    {age !== null ? <span>{t("backlog.work_age", { days: age.toFixed(1) })}</span> : null}
  </div>;
}
