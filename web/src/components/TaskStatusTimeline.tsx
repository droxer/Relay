"use client";

import type { ReactNode } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import type { LifecycleMarker } from "../lib/taskThreadLifecycle";
import type { TaskStatus } from "../types";
import type { ThreadTaskFact } from "./ThreadMeta";
import { TaskStatusIcon } from "./TaskStatusIcon";
import { historyTime } from "./task-record/taskHistoryLabel";

/** What a person does next, said only while the task still sits there. A
 *  wait has its own prompt in the composer, and running work needs nobody —
 *  so those two never carry a hint. */
const NEXT_STEP: Partial<Record<TaskStatus, string>> = {
  review: "thread.lifecycle.next_review",
  blocked: "thread.lifecycle.next_blocked",
  assigned: "thread.lifecycle.next_assigned",
  backlog: "thread.lifecycle.next_backlog",
};

/** The move in words. The same target reads differently by where it came
 *  from: running again after a question is resuming, after review is a
 *  reopen; done straight out of review by a person is their acceptance. */
export function lifecycleLabel(marker: LifecycleMarker, t: TFunction): string {
  const { from, to } = marker;
  if (from === "blocked" && to !== "blocked" && to !== "done") {
    return `${t("thread.lifecycle.unblocked")} · ${t(`backlog.statuses.${to}`)}`;
  }
  if (to === "running" && from === "waiting_for_human") return t("thread.lifecycle.resumed");
  if (to === "running" && (from === "review" || from === "done")) return t("thread.lifecycle.reopened");
  if (to === "done" && from === "review" && marker.actor !== "relay") return t("thread.lifecycle.accepted");
  return t(`thread.lifecycle.to_${to}`);
}

/**
 * Where the thread's task stands and how it got there — the body of the
 * header task chip's popover.
 *
 * These moves used to be centred dividers between the transcript's turns,
 * where four of them for one short run outweighed the answer they framed.
 * Here the standing status leads, with what to do about it; the history
 * follows as one quiet line per move. Relay's own moves name no actor — only
 * a person's hand is worth saying.
 */
export function TaskStatusTimeline({ task, markers, actions }: {
  task: ThreadTaskFact;
  /** Oldest first. */
  markers: readonly LifecycleMarker[];
  /** The task's next move as controls, when the person has one to make. */
  actions?: ReactNode;
}) {
  const { t, i18n } = useTranslation();
  const nextKey = NEXT_STEP[task.status];

  return (
    <section className="task-status" aria-label={t("thread.lifecycle.label")}>
      <div className="task-status-head" data-status={task.status}>
        <TaskStatusIcon status={task.status} className="task-status-head-icon" />
        <span className="task-status-now">{t(`backlog.statuses.${task.status}`)}</span>
        <a
          className="task-status-ref"
          href={task.href}
          translate="no"
          title={t("thread.lifecycle.open_task", { ref: task.ref })}
          onClick={(event) => {
            if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.altKey || event.ctrlKey || event.shiftKey) return;
            event.preventDefault();
            task.onOpen();
          }}
        >{task.ref}</a>
      </div>
      {task.blockerReason ? <p className="task-status-note" title={task.blockerReason}>{task.blockerReason}</p> : null}
      {nextKey ? <p className="task-status-note">{t(nextKey)}</p> : null}
      {actions ? <div className="task-status-actions">{actions}</div> : null}
      {markers.length ? (
        <ol className="task-status-steps" aria-label={t("thread.lifecycle.history")}>
          {markers.map((marker) => (
            <li key={marker.id} className="task-status-step">
              <TaskStatusIcon status={marker.to} className="task-status-step-icon" />
              <span className="task-status-step-label" title={marker.reason}>{lifecycleLabel(marker, t)}</span>
              <span className="task-status-step-meta">
                {marker.actor === "relay" ? null : <>{t(`thread.lifecycle.by_${marker.actor}`)}{" · "}</>}
                <time className="tnum" dateTime={marker.timestamp}>{historyTime(marker.timestamp, i18n.language)}</time>
              </span>
            </li>
          ))}
        </ol>
      ) : null}
    </section>
  );
}
