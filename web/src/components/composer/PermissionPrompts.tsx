import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import type { PermissionAnswers, PermissionQuestionItem, PermissionRequest } from "relay-core";
import { ActionApprove, ICON } from "../icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  answersComplete, isQuestionPrompt, mayAllowAlways, permissionInputSummary, permissionInputText, permissionNoteReachesAgent,
  type PermissionAnswerInput,
} from "@/lib/permissionRequests";

type Answer = (requestId: string, answer: PermissionAnswerInput) => Promise<void>;
/** Which button is waiting on the backend. */
type Pending = "allow" | "always" | "deny";

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
 * What a live run is paused on, docked on the composer like every other wait
 * on a person. Prompts are answered oldest first, one at a time: the slip
 * shows the oldest and counts the rest, and the next takes its place once the
 * thread's stream closes it. A prompt is either an approval (Allow once /
 * Always allow / Deny) or the agent's question, whose offered answers are one
 * click each. Always allow answers this prompt and every later one from the
 * same agent for the same tool in this thread.
 */
export function PermissionPrompts({ requests, agentLabel, onAnswer }: {
  requests: PermissionRequest[];
  /** The asking run's agent, named the way the transcript names it. */
  agentLabel: (request: PermissionRequest) => string;
  onAnswer: Answer;
}) {
  const [request] = requests;
  if (!request) return null;
  return (
    <PermissionPrompt
      key={request.id}
      request={request}
      agent={agentLabel(request)}
      waiting={requests.length}
      onAnswer={onAnswer}
    />
  );
}

/** The slip sits inside the composer's form: Enter in one of its fields must
 *  not submit the reply box underneath. */
function keepEnter(event: KeyboardEvent<HTMLInputElement>) {
  if (event.key === "Enter" && !event.nativeEvent.isComposing) event.preventDefault();
}

function PermissionPrompt({ request, agent, waiting, onAnswer }: {
  request: PermissionRequest;
  agent: string;
  /** Open prompts in the thread, this one included. */
  waiting: number;
  onAnswer: Answer;
}) {
  const { t } = useTranslation();
  const slipRef = useRef<HTMLElement>(null);
  const firstControlRef = useRef<HTMLButtonElement>(null);
  const id = useId();
  const [note, setNote] = useState("");
  const [answers, setAnswers] = useState<PermissionAnswers>({});
  const [other, setOther] = useState<Record<string, string>>({});
  const [pending, setPending] = useState<Pending | null>(null);
  const question = isQuestionPrompt(request);
  // A paused run is easy to miss, so the prompt announces itself and takes
  // focus — but only when nothing is being written: a prompt landing
  // mid-sentence must not take the caret.
  const [announced, setAnnounced] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setAnnounced(true), ANNOUNCE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, []);
  useEffect(() => {
    // Optional chaining on the method: jsdom has no scrollIntoView.
    slipRef.current?.scrollIntoView?.({ block: "nearest" });
    const focused = document.activeElement;
    const typing = focused instanceof Element && focused !== document.body && focused.closest(TYPING_TARGET);
    if (!typing) firstControlRef.current?.focus();
  }, []);

  const answer = async (choice: Pending, picked?: PermissionAnswers) => {
    if (pending) return;
    setPending(choice);
    const decision = choice === "deny" ? "deny" : "allow";
    try {
      await onAnswer(request.id, {
        decision,
        note: note.trim() || undefined,
        answers: decision === "allow" && question ? picked ?? answers : undefined,
        always: choice === "always" || undefined,
      });
    } finally {
      setPending(null);
    }
  };

  const busy = pending !== null;
  const pendingLabel = t("decision.pending");
  const title = question
    ? t("permission.question_title", { agent })
    : t("permission.title", { agent, tool: request.toolName });
  const complete = withOther(answers, other);
  return (
    <section ref={slipRef} className="composer-slip permission-prompt" aria-labelledby={`${id}-title`} data-question={question || undefined}>
      <p role="status" className="sr-only">{announced ? title : ""}</p>
      <div className="composer-slip-head">
        <h2 id={`${id}-title`} className="composer-slip-title">{title}</h2>
        <span className="composer-slip-meta">
          {waiting > 1 ? t("permission.position", { count: waiting }) : t("permission.paused")}
        </span>
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
      ) : <PermissionInput input={request.input} />}
      <div className="composer-slip-foot">
        {!question && permissionNoteReachesAgent(request) ? (
          <Input
            className="permission-prompt-note"
            name="permission-note"
            autoComplete="off"
            maxLength={NOTE_MAX_CHARS}
            aria-label={t("permission.note_label")}
            placeholder={t("permission.note_placeholder", { agent })}
            value={note}
            disabled={busy}
            onChange={(event) => setNote(event.target.value)}
            onKeyDown={keepEnter}
          />
        ) : null}
        <div className="composer-slip-actions">
          {question ? (
            <>
              <Button variant="ghost" size="dense" type="button" disabled={busy} loading={pending === "deny"} loadingLabel={pendingLabel} onClick={() => void answer("deny")}>
                {t("permission.skip")}
              </Button>
              <Button
                variant="default"
                size="dense"
                type="button"
                disabled={busy || !answersComplete(request, complete)}
                loading={pending === "allow"}
                loadingLabel={pendingLabel}
                onClick={() => void answer("allow", complete)}
              >
                {t("permission.answer")}
              </Button>
            </>
          ) : (
            <>
              {/* Deny is an ordinary answer, not a hazard: the ghost tier, so
                  Allow stays the slip's one filled control. */}
              <Button variant="ghost" size="dense" type="button" disabled={busy} loading={pending === "deny"} loadingLabel={pendingLabel} onClick={() => void answer("deny")}>
                {t("permission.deny")}
              </Button>
              {mayAllowAlways(request) ? (
                <Button
                  variant="outline"
                  size="dense"
                  type="button"
                  disabled={busy}
                  loading={pending === "always"}
                  loadingLabel={pendingLabel}
                  // Starts with the visible label, so the accessible name still matches it.
                  aria-label={t("permission.allow_always_hint", { agent, tool: request.toolName })}
                  title={t("permission.allow_always_hint", { agent, tool: request.toolName })}
                  onClick={() => void answer("always")}
                >
                  {t("permission.allow_always")}
                </Button>
              ) : null}
              <Button variant="default" size="dense" type="button" ref={firstControlRef} disabled={busy} loading={pending === "allow"} loadingLabel={pendingLabel} onClick={() => void answer("allow")}>
                <ActionApprove size={ICON.sm} /> {t("permission.allow")}
              </Button>
            </>
          )}
        </div>
      </div>
    </section>
  );
}

/**
 * What the tool would act on — the command, the file, the URL — set as the
 * thing at stake. The raw input stays one click away for anything the
 * summary leaves out.
 */
function PermissionInput({ input }: { input: string }) {
  const { t } = useTranslation();
  const summary = permissionInputSummary(input);
  if (!summary) return null;
  const full = permissionInputText(input);
  return (
    <div className="permission-prompt-target">
      <pre className="permission-prompt-input" aria-label={t("permission.input_label")}>{summary}</pre>
      {full.trim() !== summary.trim() ? (
        <details className="permission-prompt-full">
          <summary>{t("permission.full_input")}</summary>
          <pre className="permission-prompt-input">{full}</pre>
        </details>
      ) : null}
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
 * The agent's questions with their offered answers, each a click — the same
 * quote and rows as an agent's question between rounds. A single question
 * with one answer to pick sends on the click, the way the agent's own prompt
 * would; otherwise the picks collect until Answer.
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
            <p id={`${id}-q${questionIndex}`} className="awaiting-input-quote">{question.text}</p>
            {question.options.length ? (
              <ul className="awaiting-input-choices" aria-label={t("permission.options_label")}>
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
                      <span className="awaiting-input-choice-label">{option.label}</span>
                      {option.description ? <span className="awaiting-input-choice-effect">{option.description}</span> : null}
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
            <Input
              className="permission-question-other"
              name={`permission-answer-${questionIndex}`}
              autoComplete="off"
              maxLength={ANSWER_MAX_CHARS}
              aria-label={t(question.options.length ? "permission.other_label" : "permission.answer_label")}
              placeholder={t("permission.other_placeholder")}
              value={other[question.id] ?? ""}
              disabled={busy}
              onChange={(event) => onOther(question.id, event.target.value)}
              onKeyDown={keepEnter}
            />
          </div>
        );
      })}
    </div>
  );
}
