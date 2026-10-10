"use client";

import { useId } from "react";
import { useTranslation } from "react-i18next";
import type { AwaitingInput } from "../lib/awaitingInput";
import { navigateToAppPath, pathForAppState } from "../lib/appRoute";
import { taskRef } from "../lib/taskRef";
import { Button } from "@/components/ui/button";
import { IdentityMark } from "./IdentityMark";
import { ProfileImage } from "./ProfileImagePicker";

/**
 * The prompt for a thread that is parked on its human.
 *
 * It docks onto the top edge of the composer card — the reply box is the
 * answer, so the question sits attached to it rather than floating in the
 * transcript where a scrolled-up reader would lose it. The agent's own words
 * are the loud thing; everything around them stays quiet.
 */
export function AwaitingInputPrompt({ waiting, agentName, agentImage, onReply }: {
  waiting: AwaitingInput;
  agentName: string;
  agentImage?: string;
  /** Put the caret in the composer. */
  onReply: () => void;
}) {
  const { t } = useTranslation();
  const headingId = useId();
  const { task } = waiting;
  const ref = task ? taskRef(task) : null;
  const taskHref = task ? pathForAppState({ route: "backlog", mobileView: "chat", sessionId: null, taskId: task.id }) : null;
  return (
    <section className="awaiting-input" data-kind={waiting.kind} aria-labelledby={headingId}>
      <div className="awaiting-input-head">
        <span className="awaiting-input-avatar" aria-hidden="true">
          <ProfileImage src={agentImage} alt="" fallback={<IdentityMark kind="agent" />} />
        </span>
        <h2 id={headingId} className="awaiting-input-title">
          {t(waiting.kind === "question" ? "awaiting.question_title" : "awaiting.check_title", { agent: agentName })}
        </h2>
        {task && taskHref ? (
          <a
            className="awaiting-input-task"
            href={taskHref}
            translate="no"
            aria-label={t("awaiting.open_task", { ref })}
            onClick={(event) => {
              if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
              event.preventDefault();
              void navigateToAppPath(taskHref);
            }}
          >{ref}</a>
        ) : null}
      </div>
      {waiting.text ? (
        <blockquote className="awaiting-input-quote">{waiting.text}</blockquote>
      ) : (
        <p className="awaiting-input-quote" data-empty="true">{t("awaiting.no_question", { agent: agentName })}</p>
      )}
      <div className="awaiting-input-foot">
        <p className="awaiting-input-hint">
          {ref ? t("awaiting.hint_task", { ref }) : t("awaiting.hint_thread")}
        </p>
        <Button type="button" variant="ghost" size="dense" onClick={onReply}>{t("awaiting.reply")}</Button>
      </div>
    </section>
  );
}
