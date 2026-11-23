import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { WorkflowAttemptBinding, WorkflowRun } from "relay-core";
import { useRelayMutations } from "../../hooks/useRelayMutations";
import {
  currentWorkflowAssignment,
  workflowBlock,
  workflowDecisionBinding,
  workflowQuestion,
  workflowStepName,
  type WorkflowBlock,
} from "../../lib/workflowRuns";
import { ActionSend, ICON, NavMore } from "../icons";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useDialogs } from "@/components/ui/DialogProvider";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

type WorkflowDecision = "approve" | "reject" | "retry" | "cancel" | "answer";

/** The backend's answer bound (`ANSWER_LIMIT` in `collaboration/workflow_events.py`). */
const ANSWER_MAX_CHARS = 4000;

/** Something being written: the slip must not pull focus out of it. */
const TYPING_TARGET = 'input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="dialog"], [role="menu"], [role="listbox"]';

/** Whether a run needs its owner now: a gate, a step's question, or a blocked step. */
export function workflowNeedsOwner(run: WorkflowRun | undefined): run is WorkflowRun {
  return run?.status === "awaiting_approval" || run?.status === "awaiting_input" || run?.status === "blocked";
}

type Translate = (key: string, options?: Record<string, unknown>) => string;

function blockText(t: Translate, block: WorkflowBlock): string {
  switch (block.kind) {
    case "admission": return t("workflow.block_admission", { detail: block.detail });
    case "interrupted": return t("workflow.block_interrupted");
    case "rejected": return t("workflow.block_rejected");
    default: return t(`workflow.reason.${block.reason}`);
  }
}

/**
 * A workflow step waiting on its owner, docked on the composer like every
 * other wait on a person: approve or reject a gated step, or retry a blocked
 * one. Cancelling the whole run is rarer and destructive, so it sits in the
 * menu behind a confirmation. Every answer is bound to the attempt shown
 * here; a stale one is refused by the server and the thread refreshes.
 */
export function WorkflowSlip({ run, decide, focusOnMount = true }: {
  run: WorkflowRun;
  decide: (kind: WorkflowDecision, binding: WorkflowAttemptBinding, answer?: string) => Promise<unknown>;
  focusOnMount?: boolean;
}) {
  const { t } = useTranslation();
  const { confirm } = useDialogs();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const headingId = useId();
  const [pending, setPending] = useState<WorkflowDecision | string | null>(null);
  const [draft, setDraft] = useState("");
  const assignment = currentWorkflowAssignment(run);
  const binding = workflowDecisionBinding(run);

  // Focus the heading, not a verb: a stray Enter must never decide, and a
  // person mid-sentence keeps the caret.
  useEffect(() => {
    if (!focusOnMount) return;
    headingRef.current?.scrollIntoView?.({ block: "nearest" });
    const focused = document.activeElement;
    const typing = focused instanceof Element && focused !== document.body && focused.closest(TYPING_TARGET);
    if (!typing) headingRef.current?.focus();
  }, [focusOnMount]);

  if (!assignment || !binding) return null;
  const position = { index: run.currentIndex + 1, total: run.assignments.length, step: workflowStepName(run, assignment) };
  const gate = run.status === "awaiting_approval";
  const asked = workflowQuestion(run);
  const block = workflowBlock(run);

  // `pending` names the button pressed: a decision kind, or the option text answered.
  const act = async (kind: WorkflowDecision, answer?: string) => {
    if (pending) return false;
    setPending(answer ?? kind);
    try {
      await (answer === undefined ? decide(kind, binding) : decide(kind, binding, answer));
      return true;
    } catch {
      // Announced by the mutation; a 409 refetches the thread.
      return false;
    } finally {
      setPending(null);
    }
  };

  const cancelRun = async () => {
    const accepted = await confirm({
      title: t("workflow.cancel_title"),
      message: t("workflow.cancel_message"),
      confirmLabel: t("workflow.cancel_run"),
      tone: "danger",
    });
    if (accepted) await act("cancel");
  };

  const choices: ReadonlyArray<{ kind: WorkflowDecision; label: string; effect: string; answer?: string }> = asked
    ? asked.options.map((option) => ({ kind: "answer", label: option, effect: t("workflow.answer_effect"), answer: option }))
    : gate
    ? [
        { kind: "approve", label: t("workflow.approve"), effect: t("workflow.approve_effect", position) },
        { kind: "reject", label: t("workflow.reject"), effect: t("workflow.reject_effect") },
      ]
    : [
        { kind: "retry", label: t("workflow.retry"), effect: t("workflow.retry_effect", { attempt: assignment.workflowAttempt + 1 }) },
      ];

  return (
    <section className="composer-slip workflow-slip" aria-labelledby={headingId} data-state={run.status}>
      <div className="composer-slip-head">
        <h2 id={headingId} ref={headingRef} tabIndex={-1} className="composer-slip-title">
          {asked ? t("workflow.question_title", position)
            : gate ? t("workflow.gate_title", position) : t("workflow.blocked_title", position)}
        </h2>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button type="button" variant="icon" size="icon-dense" disabled={pending !== null} aria-label={t("workflow.more")} title={t("workflow.more")}>
                <NavMore size={ICON.md} aria-hidden="true" />
              </Button>
            }
          />
          <DropdownMenuContent align="end">
            <DropdownMenuItem danger onClick={() => void cancelRun()}>{t("workflow.cancel_run")}</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {asked ? (
        asked.question
          ? <blockquote className="awaiting-input-quote">{asked.question}</blockquote>
          : <p className="awaiting-input-quote" data-empty="true">{t("workflow.question_empty")}</p>
      ) : null}
      {block ? <p className="workflow-slip-reason">{blockText(t, block)}</p> : null}
      {gate && assignment.acceptanceCriteria.length ? (
        <p className="workflow-slip-reason">
          {t("workflow.gate_criteria", { criteria: assignment.acceptanceCriteria.join(t("workflow.list_separator")) })}
        </p>
      ) : null}
      {choices.length ? <ul className="awaiting-input-choices" aria-label={t("awaiting.choices")}>
        {choices.map((choice) => (
          <li key={choice.answer ?? choice.kind}>
            <button
              type="button"
              className="awaiting-input-choice"
              data-chosen={pending === (choice.answer ?? choice.kind) || undefined}
              disabled={pending !== null}
              aria-busy={pending === (choice.answer ?? choice.kind) || undefined}
              onClick={() => void act(choice.kind, choice.answer)}
            >
              <span className="awaiting-input-choice-label">{choice.label}</span>
              <span className="awaiting-input-choice-effect">{choice.effect}</span>
              <ActionSend className="awaiting-input-choice-send" size={ICON.sm} aria-hidden="true" />
            </button>
          </li>
        ))}
      </ul> : null}
      {/* On a Thread, the slip docks inside the message form. */}
      {asked ? (
        <div className="workflow-slip-answer">
          <Textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            maxLength={ANSWER_MAX_CHARS}
            rows={2}
            disabled={pending !== null}
            aria-label={t("workflow.answer_label")}
            placeholder={t("workflow.answer_placeholder")}
          />
          <Button
            type="button"
            size="sm"
            disabled={pending !== null || !draft.trim()}
            aria-busy={(pending !== null && pending === draft.trim()) || undefined}
            onClick={async () => {
              const answer = draft.trim();
              if (answer && await act("answer", answer)) setDraft("");
            }}
          >
            {t("workflow.answer_send")}
          </Button>
        </div>
      ) : null}
    </section>
  );
}

/** The workflow slip wired to its Thread's decision route. */
export function ThreadWorkflowSlip({ sessionId, run, focusOnMount }: {
  sessionId: string;
  run: WorkflowRun;
  focusOnMount?: boolean;
}) {
  const { decideWorkflowMutation } = useRelayMutations();
  return (
    <WorkflowSlip
      run={run}
      focusOnMount={focusOnMount}
      decide={(kind, binding, answer) => decideWorkflowMutation.mutateAsync({ sessionId, kind, binding, answer })}
    />
  );
}
