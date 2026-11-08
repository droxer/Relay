"use client";

import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import type { ThreadTaskFact } from "./ThreadMeta";
import { TaskStatusIcon } from "./TaskStatusIcon";
import type { TaskStatusAction } from "../hooks/useTaskStatusActions";

/** The statuses that wait on a person's hand without an agent's question —
 *  a question has its own prompt (`AwaitingInputPrompt`) in this slot. */
export function taskNeedsAction(status: ThreadTaskFact["status"] | undefined): boolean {
  return status === "review" || status === "blocked";
}

/**
 * The one line that says the thread's task needs you, docked on the composer.
 *
 * It appears only while the task waits on a person — work in review, or a
 * block — and carries that move as a button, so accepting the result is one
 * click from where you just read it. "Request changes" is the composer
 * itself: it puts the caret there, because asking for changes is a message.
 */
export function TaskActionBar({ task, busy, deferPrimary = false, onAccept, onUnblock, onReply }: {
  task: ThreadTaskFact;
  busy: TaskStatusAction | null;
  /** Set while the transcript's DecisionBar holds the view's one filled
   *  primary; Accept then steps down to the outline tier. */
  deferPrimary?: boolean;
  onAccept: () => void;
  onUnblock: () => void;
  /** Put the caret in the composer. */
  onReply: () => void;
}) {
  const { t } = useTranslation();
  const review = task.status === "review";
  return (
    <section className="task-action-bar" data-status={task.status} aria-label={t("thread.lifecycle.action_label")}>
      <TaskStatusIcon status={task.status} className="task-action-bar-icon" />
      <p className="task-action-bar-text">
        <span translate="no">{task.ref}</span>{" "}
        {t(review ? "thread.lifecycle.bar_review" : "thread.lifecycle.bar_blocked")}
        {!review && task.blockerReason ? (
          <span className="task-action-bar-reason" title={task.blockerReason}>{" · "}{task.blockerReason}</span>
        ) : null}
      </p>
      <div className="task-action-bar-actions">
        {review ? (
          <>
            <Button type="button" variant="ghost" size="dense" disabled={busy !== null} onClick={onReply}>
              {t("thread.lifecycle.request_changes")}
            </Button>
            <Button type="button" variant={deferPrimary ? "outline" : "default"} size="dense" disabled={busy !== null} loading={busy === "accept"} onClick={onAccept}>
              {t("thread.lifecycle.accept")}
            </Button>
          </>
        ) : (
          <Button type="button" variant="outline" size="dense" disabled={busy !== null} loading={busy === "unblock"} onClick={onUnblock}>
            {t("thread.lifecycle.unblock")}
          </Button>
        )}
      </div>
    </section>
  );
}
