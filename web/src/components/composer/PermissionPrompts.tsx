import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { PermissionAnswers, PermissionQuestionItem, PermissionRequest } from "relay-core";
import { ActionApprove, ActionSend, ICON } from "../icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { answersComplete, isQuestionPrompt, permissionInputText, permissionNoteReachesAgent } from "@/lib/permissionRequests";

type Answer = (requestId: string, decision: "allow" | "deny", note?: string, answers?: PermissionAnswers) => Promise<void>;

/** Mirrors `PERMISSION_NOTE_MAX_CHARS` in backend/relay/core/permission_requests.py. */
const NOTE_MAX_CHARS = 1000;
/** Mirrors `PERMISSION_TEXT_MAX_CHARS` there. */
const ANSWER_MAX_CHARS = 500;
/** Something being written: a prompt must not pull focus out of it. */
const TYPING_TARGET = 'input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="dialog"], [role="menu"], [role="listbox"]';
/** Long enough after mount that the live region is in the accessibility tree
 *  before its words arrive; filled at insertion it is not reliably read. */
const ANNOUNCE_DELAY_MS = 150;

/**
 * The prompts a live run is paused on: one card per tool call it asked to
 * make, oldest first, each answered on its own. The run resumes when its
 * prompt is answered, so the card leaves once the thread's stream closes it.
 * A card is either an approval (Allow / Deny) or the agent's question, whose
 * offered answers are one click each.
 */
export function PermissionPrompts({ requests, agentLabel, onAnswer }: {
  requests: PermissionRequest[];
  /** The asking run's agent, named the way the transcript names it. */
  agentLabel: (request: PermissionRequest) => string;
  onAnswer: Answer;
}) {
  const { t } = useTranslation();
  if (requests.length === 0) return null;
  return (
    <section className="permission-prompts" aria-label={t("permission.region")}>
      {requests.map((request, index) => (
        <PermissionPrompt
          key={request.id}
          request={request}
          agent={agentLabel(request)}
          primary={index === 0}
          onAnswer={onAnswer}
        />
      ))}
    </section>
  );
}

function PermissionPrompt({ request, agent, primary, onAnswer }: {
  request: PermissionRequest;
  agent: string;
  primary: boolean;
  onAnswer: Answer;
}) {
  const { t } = useTranslation();
  const cardRef = useRef<HTMLDivElement>(null);
  const firstControlRef = useRef<HTMLButtonElement>(null);
  const id = useId();
  const [note, setNote] = useState("");
  const [answers, setAnswers] = useState<PermissionAnswers>({});
  const [other, setOther] = useState<Record<string, string>>({});
  const [pending, setPending] = useState<"allow" | "deny" | null>(null);
  const question = isQuestionPrompt(request);
  // A paused run is easy to miss mid-transcript, so the first card announces
  // itself and scrolls into view. Focus moves to it only when nothing is
  // being written: a prompt landing mid-sentence must not take the caret.
  const [announced, setAnnounced] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setAnnounced(true), ANNOUNCE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, []);
  useEffect(() => {
    if (!primary) return;
    // Optional chaining on the method: jsdom has no scrollIntoView.
    cardRef.current?.scrollIntoView?.({ block: "nearest" });
    const focused = document.activeElement;
    const typing = focused instanceof Element && focused !== document.body && focused.closest(TYPING_TARGET);
    if (!typing) firstControlRef.current?.focus();
  }, [primary]);

  const answer = async (decision: "allow" | "deny", picked?: PermissionAnswers) => {
    if (pending) return;
    setPending(decision);
    try {
      await onAnswer(request.id, decision, note.trim() || undefined, decision === "allow" && question ? picked ?? answers : undefined);
    } finally {
      setPending(null);
    }
  };

  const busy = pending !== null;
  const pendingLabel = t("decision.pending");
  const title = question
    ? t("permission.question_title", { agent })
    : t("permission.title", { agent, tool: request.toolName });
  return (
    <div ref={cardRef} className="permission-prompt" role="group" aria-labelledby={`${id}-title`} data-question={question || undefined}>
      <p role="status" className="sr-only">{announced && primary ? title : ""}</p>
      <div className="permission-prompt-head">
        <span id={`${id}-title`} className="permission-prompt-title">{title}</span>
        <span className="permission-prompt-summary">{t(question ? "permission.question_summary" : "permission.summary")}</span>
      </div>
      {question ? (
        <PermissionQuestions
          questions={request.questions ?? []}
          answers={answers}
          other={other}
          busy={busy}
          firstControlRef={firstControlRef}
          onPick={(next) => setAnswers(next)}
          onOther={(questionId, text) => setOther((current) => ({ ...current, [questionId]: text }))}
          onSubmit={(picked) => void answer("allow", picked)}
        />
      ) : request.input ? (
        <pre className="permission-prompt-input" aria-label={t("permission.input_label")}>
          {permissionInputText(request.input)}
        </pre>
      ) : null}
      {!question && permissionNoteReachesAgent(request) ? (
        <div className="permission-prompt-note">
          <Label htmlFor={`${id}-note`}>{t("permission.note_label")}</Label>
          <Input
            id={`${id}-note`}
            name="permission-note"
            autoComplete="off"
            maxLength={NOTE_MAX_CHARS}
            placeholder={t("permission.note_placeholder")}
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
        </div>
      ) : null}
      <div className="decision-bar">
        {question ? (
          <>
            <Button
              variant={primary ? "default" : "outline"}
              type="button"
              disabled={busy || !answersComplete(request, withOther(answers, other))}
              loading={pending === "allow"}
              loadingLabel={pendingLabel}
              onClick={() => void answer("allow", withOther(answers, other))}
            >
              <ActionSend size={ICON.sm} /> {t("permission.answer")}
            </Button>
            <Button variant="ghost" type="button" disabled={busy} loading={pending === "deny"} loadingLabel={pendingLabel} onClick={() => void answer("deny")}>
              {t("permission.skip")}
            </Button>
          </>
        ) : (
          <>
            {/* One accent fill per view: only the first open prompt's Allow is
                the primary; the rest wait in the outline tier. */}
            <Button variant={primary ? "default" : "outline"} type="button" ref={firstControlRef} disabled={busy} loading={pending === "allow"} loadingLabel={pendingLabel} onClick={() => void answer("allow")}>
              <ActionApprove size={ICON.sm} /> {t("permission.allow")}
            </Button>
            <Button variant="destructive" type="button" disabled={busy} loading={pending === "deny"} loadingLabel={pendingLabel} onClick={() => void answer("deny")}>
              {t("permission.deny")}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

/** The picks plus whatever the person wrote in an "other" box. */
function withOther(answers: PermissionAnswers, other: Record<string, string>): PermissionAnswers {
  const merged: PermissionAnswers = { ...answers };
  for (const [questionId, text] of Object.entries(other)) {
    const written = text.trim();
    if (written) merged[questionId] = [...(merged[questionId] ?? []), written];
  }
  return merged;
}

/**
 * The agent's questions with their offered answers, each a click. A single
 * question with one answer to pick sends on the click, the way the agent's
 * own prompt would; otherwise the picks collect until Answer.
 */
function PermissionQuestions({ questions, answers, other, busy, firstControlRef, onPick, onOther, onSubmit }: {
  questions: PermissionQuestionItem[];
  answers: PermissionAnswers;
  other: Record<string, string>;
  busy: boolean;
  firstControlRef: React.RefObject<HTMLButtonElement | null>;
  onPick: (answers: PermissionAnswers) => void;
  onOther: (questionId: string, text: string) => void;
  onSubmit: (answers: PermissionAnswers) => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const sendsOnPick = questions.length === 1 && !questions[0].multiSelect;
  const pick = (question: PermissionQuestionItem, label: string) => {
    const current = answers[question.id] ?? [];
    const next = question.multiSelect
      ? current.includes(label) ? current.filter((item) => item !== label) : [...current, label]
      : [label];
    const picked = { ...answers, [question.id]: next };
    if (sendsOnPick && !(other[question.id] ?? "").trim()) onSubmit(picked);
    else onPick(picked);
  };
  return (
    <div className="permission-questions">
      {questions.map((question, questionIndex) => {
        const picked = answers[question.id] ?? [];
        return (
          <div key={question.id} className="permission-question" role="group" aria-labelledby={`${id}-q${questionIndex}`}>
            <p id={`${id}-q${questionIndex}`} className="permission-question-text">{question.text}</p>
            {question.options.length ? (
              <ul className="awaiting-input-choices permission-question-options" aria-label={t("permission.options_label")}>
                {question.options.map((option, optionIndex) => (
                  <li key={option.label}>
                    <button
                      type="button"
                      className="awaiting-input-choice"
                      ref={questionIndex === 0 && optionIndex === 0 ? firstControlRef : undefined}
                      role={question.multiSelect ? "checkbox" : "radio"}
                      aria-checked={picked.includes(option.label)}
                      data-chosen={picked.includes(option.label) || undefined}
                      disabled={busy}
                      onClick={() => pick(question, option.label)}
                    >
                      <kbd className="awaiting-input-choice-key" aria-hidden="true">{optionIndex + 1}</kbd>
                      <span className="awaiting-input-choice-label">
                        {option.label}
                        {option.description ? <span className="permission-option-description">{option.description}</span> : null}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
            <div className="permission-prompt-note">
              <Label htmlFor={`${id}-other${questionIndex}`}>{t(question.options.length ? "permission.other_label" : "permission.answer_label")}</Label>
              <Input
                id={`${id}-other${questionIndex}`}
                name={`permission-answer-${questionIndex}`}
                autoComplete="off"
                maxLength={ANSWER_MAX_CHARS}
                placeholder={t("permission.other_placeholder")}
                value={other[question.id] ?? ""}
                disabled={busy}
                onChange={(event) => onOther(question.id, event.target.value)}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}
