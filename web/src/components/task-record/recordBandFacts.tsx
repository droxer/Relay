"use client";

import { routineState } from "../../lib/routine";
import { taskRef } from "../../lib/taskRef";
import type { RelayTaskListItem } from "../../types";
import { formatNextRunDate } from "../task-board/RoutineChrome";
import { RoutineStateBadge } from "../RoutineStateBadge";
import { StateMark } from "../StateMark";
import { TASK_STATUS_SHAPE } from "../task-board/backlogVocabulary";
import type { RecordFact } from "../workspace/RecordBand";

/**
 * The record's spine: the same facts the list row carried, so a reader who
 * clicked a row still sees what they clicked. Nothing in a tab may restate
 * one of these — see `RecordBand`.
 *
 * It lives in its own module because two surfaces state it: the record page
 * and the board's peek drawer. A second hand-written facts list is how those
 * two end up disagreeing about what a task's status is.
 */
export function recordBandFacts(
  task: RelayTaskListItem,
  variant: "task" | "routine",
  running: ReadonlySet<string>,
  locale: string,
  t: (key: string, options?: Record<string, unknown>) => string,
): RecordFact[] {
  const facts: RecordFact[] = [];
  if (variant === "routine") {
    facts.push({
      key: "state",
      label: t("routine.state"),
      value: <RoutineStateBadge state={routineState(task, running)} always />,
    });
    facts.push({
      key: "cadence",
      label: t("routine.cadence"),
      value: task.routineCadence ? t(`routine.cadences.${task.routineCadence}`) : "—",
    });
    facts.push({
      key: "next-run",
      label: t("routine.next_run"),
      value: task.routineNextRunDate ? formatNextRunDate(task.routineNextRunDate) : "—",
    });
  } else {
    facts.push({
      key: "status",
      label: t("backlog.status"),
      value: (
        <span className="record-band-inline">
          <StateMark shape={TASK_STATUS_SHAPE[task.status]} />
          {t(`backlog.statuses.${task.status}`)}
        </span>
      ),
    });
    facts.push({
      key: "due",
      label: task.scheduledFor ? t("record.scheduled_for") : t("backlog.due"),
      value: recordDate(task.scheduledFor ?? task.dueDate, locale),
    });
  }
  facts.push({
    key: "assignee",
    label: t("backlog.assignee"),
    value: task.assigneeEmployeeId ?? t("backlog.unassigned"),
  });
  facts.push({
    key: "ref",
    label: t("backlog.col_ref"),
    value: taskRef(task.id),
    technical: true,
    title: task.id,
  });
  return facts;
}

export function recordDate(value: string | undefined, locale: string): string {
  if (!value) return "—";
  return formatNextRunDate(value) || new Date(value).toLocaleDateString(locale || undefined);
}
