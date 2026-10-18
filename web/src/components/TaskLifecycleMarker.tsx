"use client";

import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import type { LifecycleMarker } from "../lib/taskThreadLifecycle";
import type { TaskStatus } from "../types";
import { TaskStatusIcon } from "./TaskStatusIcon";
import { historyTime } from "./task-record/taskHistoryLabel";

/** What a person does next, said only on the move the task is still sitting
 *  on. A wait has its own prompt in the composer, and running work needs
 *  nobody — so those two never carry a hint. */
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
 * One status change of the thread's task, drawn where it happened.
 *
 * It reads like the transcript's handoff divider — a rule with a centred
 * label — so it never competes with a turn, but it wears the task's own
 * status glyph and colour: the same mark the board and the record use, so the
 * reader recognises the stage without reading the word.
 */
export function TaskLifecycleMarker({ marker, current, taskHref, taskLabel, onOpenTask }: {
  marker: LifecycleMarker;
  /** The task still sits on this move — the newest marker of a live task. */
  current: boolean;
  taskHref?: string;
  /** `#12` — names the task in the next-step link. */
  taskLabel?: string;
  onOpenTask?: () => void;
}) {
  const { t, i18n } = useTranslation();
  const label = lifecycleLabel(marker, t);
  const actor = t(`thread.lifecycle.by_${marker.actor}`);
  const time = historyTime(marker.timestamp, i18n.language);
  const nextKey = current ? NEXT_STEP[marker.to] : undefined;

  return (
    <div className="transcript-lifecycle" data-status={marker.to} data-current={current || undefined}>
      <div className="transcript-lifecycle-line">
        <span className="transcript-lifecycle-label">
          <TaskStatusIcon status={marker.to} className="transcript-lifecycle-icon" />
          <span className="transcript-lifecycle-text">
            <span className="sr-only">{t("thread.lifecycle.label")}: </span>
            <span className="transcript-lifecycle-status">{label}</span>
            {" · "}{actor}{" · "}
            <time dateTime={marker.timestamp}>{time}</time>
          </span>
        </span>
      </div>
      {marker.reason ? (
        <p className="transcript-lifecycle-detail" title={marker.reason}>{marker.reason}</p>
      ) : null}
      {nextKey ? (
        <p className="transcript-lifecycle-detail">
          {t(nextKey)}
          {taskHref && taskLabel && onOpenTask ? (
            <>
              {" "}
              <a
                className="transcript-lifecycle-link"
                href={taskHref}
                translate="no"
                onClick={(event) => {
                  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.altKey || event.ctrlKey || event.shiftKey) return;
                  event.preventDefault();
                  onOpenTask();
                }}
              >{taskLabel}</a>
            </>
          ) : null}
        </p>
      ) : null}
    </div>
  );
}
