"use client";

import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AwaitingInput } from "../lib/awaitingInput";
import { navigateToAppPath, pathForAppState } from "../lib/appRoute";
import { taskRef } from "../lib/taskRef";
import { Button } from "@/components/ui/button";
import { ActionSend, ICON } from "./icons";
import { IdentityMark } from "./IdentityMark";
import { ProfileImage } from "./ProfileImagePicker";

type Choice = { label: string; reply: string };

/**
 * The prompt for a thread that is parked on its human.
 *
 * It docks onto the top edge of the composer card — the reply box is the
 * answer, so the question sits attached to it rather than floating in the
 * transcript where a scrolled-up reader would lose it. The agent's own words
 * are the loud thing; everything around them stays quiet.
 *
 * Answering should be a pick, not a chore: the agent's offered answers (or,
 * for a gate stop, the two next steps that always make sense) are one click
 * each and send as the reply. Typing stays available for anything else.
 */
export function AwaitingInputPrompt({ waiting, agentName, agentImage, onChoose, onReply }: {
  waiting: AwaitingInput;
  agentName: string;
  agentImage?: string;
  /** Send this answer as the reply. */
  onChoose: (reply: string) => Promise<boolean>;
  /** Put the caret in the composer. */
  onReply: () => void;
}) {
  const { t } = useTranslation();
  const headingId = useId();
  const [chosen, setChosen] = useState<number | null>(null);
  const { task } = waiting;
  const ref = task ? taskRef(task) : null;
  const taskHref = task ? pathForAppState({ route: "backlog", mobileView: "chat", sessionId: null, taskId: task.id }) : null;
  const choices: Choice[] = waiting.kind === "check"
    ? [
      { label: t("awaiting.choice_continue"), reply: t("awaiting.choice_continue_reply") },
      { label: t("awaiting.choice_status"), reply: t("awaiting.choice_status_reply") },
    ]
    : waiting.options.map((option) => ({ label: option, reply: option }));
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
      {choices.length ? (
        <ul className="awaiting-input-choices" aria-label={t("awaiting.choices")}>
          {choices.map((choice, index) => (
            <li key={choice.reply}>
              <button
                type="button"
                className="awaiting-input-choice"
                data-chosen={chosen === index || undefined}
                disabled={chosen !== null}
                aria-busy={chosen === index || undefined}
                onClick={async () => {
                  setChosen(index);
                  try {
                    if (!await onChoose(choice.reply)) setChosen(null);
                  } catch {
                    setChosen(null);
                  }
                }}
              >
                <span className="awaiting-input-choice-key" aria-hidden="true">{index + 1}</span>
                <span className="awaiting-input-choice-label">{choice.label}</span>
                <ActionSend className="awaiting-input-choice-send" size={ICON.sm} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="awaiting-input-foot">
        <p className="awaiting-input-hint">
          {choices.length
            ? (ref ? t("awaiting.hint_choices_task", { ref }) : t("awaiting.hint_choices_thread"))
            : (ref ? t("awaiting.hint_task", { ref }) : t("awaiting.hint_thread"))}
        </p>
        <Button type="button" variant="ghost" size="dense" disabled={chosen !== null} onClick={onReply}>
          {t(choices.length ? "awaiting.write_own" : "awaiting.reply")}
        </Button>
      </div>
    </section>
  );
}
