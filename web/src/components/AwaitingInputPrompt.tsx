"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AwaitingInput } from "../lib/awaitingInput";
import { navigateToAppPath, pathForAppState } from "../lib/appRoute";
import { taskRef } from "../lib/taskRef";
import { Button } from "@/components/ui/button";
import { ActionSend, ICON } from "./icons";

type Choice = {
  label: string;
  /** Sent as the reply. A choice with `act` sends nothing to the agent. */
  reply: string;
  /** `discuss` asks without resuming: a status question must not hand the
   *  agent a task round whose verdict could continue or close the task. */
  intent?: "discuss";
  /** Approves the step an approval wait holds back (ADR-023). */
  approve?: true;
  /** Acts on the task instead of replying; resolves false when it did not. */
  act?: () => Promise<boolean>;
  /** What picking it does to the work, said on the row itself, so the
   *  person never has to read a paragraph to tell the choices apart. */
  effect?: string;
  /** What the prompt says once the pick went through. */
  sent: string;
};

const TITLE_KEYS = {
  question: "awaiting.question_title",
  check: "awaiting.check_title",
  budget: "awaiting.budget_title",
  approval: "awaiting.approval_title",
} as const satisfies Record<AwaitingInput["kind"], string>;

/** Typing here is someone writing, not picking an answer. */
const TYPING_TARGET = 'input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="dialog"], [role="menu"], [role="listbox"]';
/** Long enough after mount that the live region is in the accessibility tree
 *  before its words arrive; filled at insertion it is not reliably read. */
const ANNOUNCE_DELAY_MS = 150;

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
 * each and send as the reply — by click or by its number key while nothing
 * else has focus (or focus is on the prompt itself). Typing stays available
 * for anything else.
 */
export function AwaitingInputPrompt({ waiting, agentName, nextAgentName, onChoose, onReply, onMarkDone }: {
  waiting: AwaitingInput;
  agentName: string;
  /** An approval's: who takes the held step once it is approved. */
  nextAgentName?: string;
  /** Send this answer as the reply. */
  onChoose: (reply: string, options?: { intent?: "discuss"; approve?: true }) => Promise<boolean>;
  /** Put the caret in the composer. */
  onReply: () => void;
  /** Accept the task as it stands — the person's own mark done. */
  onMarkDone?: () => Promise<boolean>;
}) {
  const { t } = useTranslation();
  const headingId = useId();
  const sectionRef = useRef<HTMLElement | null>(null);
  const [chosen, setChosen] = useState<number | null>(null);
  // Set once a pick went through: the prompt then says what happens next
  // instead of leaving a lit row and silence until the thread moves on.
  const [sent, setSent] = useState<string | null>(null);
  // A prompt appearing when a round finishes is news to a screen reader user
  // whose focus is elsewhere. Said once: the words never change afterwards,
  // so later renders say nothing.
  const [announced, setAnnounced] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setAnnounced(true), ANNOUNCE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, []);
  const { task } = waiting;
  const ref = task ? taskRef(task) : null;
  const taskHref = task ? pathForAppState({ route: "backlog", mobileView: "chat", sessionId: null, taskId: task.id }) : null;
  // A gate stop and a spent budget both leave the next step to the person;
  // only an agent's question brings its own answers.
  const asked = waiting.kind === "question";
  // An approval holds the team's next step for the person: approving is one
  // pick, and anything written asks for changes instead (ADR-023).
  const approval = waiting.kind === "approval";
  // The person may judge the work finished whatever the agent left unsaid;
  // beside an agent's own answers it would read as one of them, so a
  // question keeps only those.
  const resumed = t("awaiting.sent_resume", { agent: agentName });
  const markDone: Choice | null = !asked && ref && onMarkDone
    ? {
      label: t("awaiting.choice_mark_done", { ref }),
      reply: "mark_done",
      act: onMarkDone,
      effect: t("awaiting.effect_close", { ref }),
      sent: t("awaiting.sent_done", { ref }),
    }
    : null;
  const choices: Choice[] = approval
    ? [
      {
        label: t("awaiting.choice_approve"),
        reply: t("awaiting.choice_approve_reply"),
        approve: true,
        sent: nextAgentName
          ? t("awaiting.sent_resume", { agent: nextAgentName })
          : t("awaiting.sent_approval"),
      },
      ...(markDone ? [markDone] : []),
    ]
    : !asked
    ? [
      {
        label: t("awaiting.choice_continue"),
        reply: t("awaiting.choice_continue_reply"),
        effect: ref ? t("awaiting.effect_resume", { ref }) : t("awaiting.effect_resume_thread"),
        sent: resumed,
      },
      {
        label: t("awaiting.choice_status"),
        reply: t("awaiting.choice_status_reply"),
        intent: "discuss",
        effect: t("awaiting.effect_stays"),
        sent: t("awaiting.sent_discuss", { agent: agentName }),
      },
      ...(markDone ? [markDone] : []),
    ]
    : waiting.options.map((option) => ({ label: option, reply: option, sent: resumed }));
  const choose = async (index: number) => {
    const choice = choices[index];
    if (!choice || chosen !== null) return;
    setChosen(index);
    try {
      const done = choice.act
        ? await choice.act()
        : await onChoose(
          choice.reply,
          choice.intent ? { intent: choice.intent } : choice.approve ? { approve: true } : undefined,
        );
      if (done) setSent(choice.sent);
      else setChosen(null);
    } catch {
      setChosen(null);
    }
  };
  // The number on each answer is its key. Read through a ref so the listener
  // is installed once yet always picks from this render's answers.
  const chooseRef = useRef(choose);
  useEffect(() => { chooseRef.current = choose; });
  const choiceCount = choices.length;
  useEffect(() => {
    if (!choiceCount) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
      if (event.target instanceof Element && event.target.closest(TYPING_TARGET)) return;
      // An irreversible reply must not fire from a key meant for something
      // else: with focus on any other control (a row, a link, a button) the
      // number belongs to that control's surface, not to this prompt.
      const focused = document.activeElement;
      if (focused && focused !== document.body && !sectionRef.current?.contains(focused)) return;
      const index = Number(event.key) - 1;
      if (!Number.isInteger(index) || index < 0 || index >= choiceCount) return;
      event.preventDefault();
      void chooseRef.current(index);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [choiceCount]);
  // The hint says only what the controls cannot: which task a reply resumes,
  // or that a bare reply box continues the work. A gate stop's rows each say
  // their own effect; an approval names the task its next step resumes.
  const hint = approval
    ? (ref ? t("awaiting.hint_approval_task", { ref }) : null)
    : !asked
    ? null
    : choices.length
      ? (ref ? t("awaiting.hint_choices_task", { ref }) : null)
      : (ref ? t("awaiting.hint_task", { ref }) : t("awaiting.hint_thread"));
  // An agent that never filed its report usually said why in its last
  // message — a question, a blocker. Quoting the gate instead would put
  // bookkeeping in front of what the agent actually asked.
  const unreported = waiting.unreported === true;
  const title = unreported
    ? t("awaiting.unreported_title", { agent: agentName })
    : t(TITLE_KEYS[waiting.kind], { agent: agentName });
  return (
    <section ref={sectionRef} className="awaiting-input" data-kind={waiting.kind} aria-labelledby={headingId}>
      <p role="status" className="sr-only">{announced ? title : ""}</p>
      <div className="awaiting-input-head">
        <h2 id={headingId} className="awaiting-input-title">{title}</h2>
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
      {approval ? (
        <p className="awaiting-input-quote" data-empty="true">
          {nextAgentName
            ? t("awaiting.approval_text", { agent: agentName, next: nextAgentName })
            : t("awaiting.approval_text_unnamed", { agent: agentName })}
        </p>
      ) : unreported ? (
        <p className="awaiting-input-quote" data-empty="true">{t("awaiting.unreported_text", { agent: agentName })}</p>
      ) : waiting.text ? (
        <blockquote className="awaiting-input-quote">{waiting.text}</blockquote>
      ) : (
        <p className="awaiting-input-quote" data-empty="true">{t("awaiting.no_question", { agent: agentName })}</p>
      )}
      {waiting.notes.length ? <AwaitingInputNotes notes={waiting.notes} collapsed /> : null}
      {sent ? (
        <p className="awaiting-input-sent" role="status">
          <ActionSend size={ICON.sm} aria-hidden="true" />
          <span>{sent}</span>
        </p>
      ) : choices.length ? (
        <ul className="awaiting-input-choices" aria-label={t("awaiting.choices")}>
          {choices.map((choice, index) => (
            <li key={choice.reply}>
              <button
                type="button"
                className="awaiting-input-choice"
                data-chosen={chosen === index || undefined}
                disabled={chosen !== null}
                aria-busy={chosen === index || undefined}
                aria-keyshortcuts={String(index + 1)}
                aria-describedby={choice.effect ? `${headingId}-effect-${index}` : undefined}
                onClick={() => void choose(index)}
              >
                <kbd className="awaiting-input-choice-key" aria-hidden="true">{index + 1}</kbd>
                <span className="awaiting-input-choice-label">{choice.label}</span>
                {choice.effect ? <span id={`${headingId}-effect-${index}`} className="awaiting-input-choice-effect" aria-hidden="true">{choice.effect}</span> : null}
                <ActionSend className="awaiting-input-choice-send" size={ICON.sm} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {sent ? null : <div className="awaiting-input-foot">
        {hint ? <p className="awaiting-input-hint">{hint}</p> : null}
        <Button type="button" variant="ghost" size="dense" disabled={chosen !== null} onClick={onReply}>
          {t(approval ? "awaiting.request_changes" : choices.length ? "awaiting.write_own" : "awaiting.reply")}
        </Button>
      </div>}
    </section>
  );
}

/**
 * What else stopped the round. The question is what to answer; these are the
 * acceptance gates it stood in front of, so the person answering is not
 * surprised when the next round stops on them.
 */
export function AwaitingInputNotes({ notes, collapsed = false }: {
  notes: readonly string[];
  /** Folded behind a one-line summary, where the question must stay the loud thing. */
  collapsed?: boolean;
}) {
  const { t } = useTranslation();
  const headingId = useId();
  const list = <ul>{notes.map((note) => <li key={note}>{note}</li>)}</ul>;
  if (collapsed) {
    return (
      <details className="awaiting-input-notes">
        <summary className="awaiting-input-notes-title">{t("awaiting.notes_summary", { count: notes.length })}</summary>
        {list}
      </details>
    );
  }
  return (
    <div className="awaiting-input-notes" role="group" aria-labelledby={headingId}>
      <p id={headingId} className="awaiting-input-notes-title">{t("awaiting.notes_title")}</p>
      {list}
    </div>
  );
}
