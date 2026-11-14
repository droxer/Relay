"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { taskRef } from "../lib/taskRef";
import type { RelayTaskListItem } from "../types";
import { ActionAdd, ActionFollowUp, ActionSend, CheckIcon, ICON } from "./icons";

/** Turning a suggestion into a task, when the thread's scope allows it. */
export type NextStepAdoption = {
  /** Where an adopted task lands: the project's name, or null for no project. */
  projectName: string | null;
  /** The live task this suggestion already became in that scope. */
  adoptedTask: (step: string) => RelayTaskListItem | undefined;
  /** Create the task; rejects when it was not created. */
  onAdopt: (step: string) => Promise<RelayTaskListItem>;
  onOpenTask: (task: RelayTaskListItem) => void;
};

/**
 * What the agent suggests asking next, under its finished turn.
 *
 * Each is a complete request in the person's own voice, so one click sends it
 * as the next message — the same contract as an offered answer. They are
 * offers, not the agent's words: quiet outline rows that light up on intent,
 * and gone as soon as anything new happens in the thread. Beside each, Adopt
 * keeps the suggestion as a task instead — after a confirm that names where
 * the task will land, since it outlives the thread.
 */
export function NextSteps({ steps, onSend, adoption }: {
  steps: readonly string[];
  /** Send this as the next message; resolves false when it was not sent. */
  onSend: (text: string) => Promise<boolean>;
  adoption?: NextStepAdoption;
}) {
  const { t } = useTranslation();
  const headingId = useId();
  const [sending, setSending] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  if (!steps.length) return null;
  const send = async (step: string) => {
    if (sending !== null) return;
    setSending(step);
    try {
      if (!(await onSend(step))) setSending(null);
    } catch {
      setSending(null);
    }
  };
  const destination = adoption?.projectName ?? t("next_steps.no_project");
  return (
    <section className="next-steps" aria-labelledby={headingId}>
      <h2 id={headingId} className="next-steps-title">{t("next_steps.title")}</h2>
      {adoption ? <p className="next-steps-hint">{t("next_steps.hint", { destination })}</p> : null}
      <ul className="next-steps-list">
        {steps.map((step) => (
          <li key={step} className="next-steps-row">
            <div className="next-steps-line">
              <button
                type="button"
                className="next-steps-item"
                data-sending={sending === step || undefined}
                disabled={sending !== null}
                aria-busy={sending === step || undefined}
                onClick={() => void send(step)}
              >
                <ActionFollowUp className="next-steps-mark" size={ICON.sm} aria-hidden="true" />
                <span className="next-steps-label">{step}</span>
                <ActionSend className="next-steps-send" size={ICON.sm} aria-hidden="true" />
              </button>
              {adoption ? (
                <AdoptStep
                  step={step}
                  destination={destination}
                  adoption={adoption}
                  disabled={sending !== null}
                  onAdopted={(task) => setAnnouncement(t("next_steps.adopted_announce", { ref: taskRef(task), destination }))}
                />
              ) : null}
            </div>
          </li>
        ))}
      </ul>
      <p className="sr-only" role="status" aria-live="polite">{announcement}</p>
    </section>
  );
}

type AdoptState = "idle" | "confirming" | "creating" | "failed";

/** One suggestion's Adopt control: button → confirm → created task link. */
function AdoptStep({ step, destination, adoption, disabled, onAdopted }: {
  step: string;
  destination: string;
  adoption: NextStepAdoption;
  disabled: boolean;
  onAdopted: (task: RelayTaskListItem) => void;
}) {
  const { t } = useTranslation();
  const confirmId = useId();
  const [state, setState] = useState<AdoptState>("idle");
  const [created, setCreated] = useState<RelayTaskListItem | null>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const adoptRef = useRef<HTMLButtonElement>(null);
  const task = created ?? adoption.adoptedTask(step);
  const open = state !== "idle";

  useEffect(() => {
    if (state === "confirming") confirmRef.current?.focus();
  }, [state]);

  if (task && !open) {
    return (
      <button
        type="button"
        className="next-steps-adopted"
        onClick={() => adoption.onOpenTask(task)}
        aria-label={t("next_steps.open_task", { ref: taskRef(task) })}
      >
        <CheckIcon size={ICON.sm} aria-hidden="true" />
        <span>{t("next_steps.adopted", { ref: taskRef(task) })}</span>
      </button>
    );
  }

  const cancel = () => {
    setState("idle");
    adoptRef.current?.focus();
  };
  const create = async () => {
    setState("creating");
    try {
      const next = await adoption.onAdopt(step);
      setCreated(next);
      setState("idle");
      onAdopted(next);
    } catch {
      setState("failed");
    }
  };

  return (
    <>
      <button
        ref={adoptRef}
        type="button"
        className="next-steps-adopt"
        aria-expanded={open}
        aria-controls={open ? confirmId : undefined}
        aria-label={t("next_steps.adopt_label", { step })}
        disabled={disabled || open}
        onClick={() => setState("confirming")}
      >
        <ActionAdd size={ICON.sm} aria-hidden="true" />
        <span>{t("next_steps.adopt")}</span>
      </button>
      {open ? (
        <div
          id={confirmId}
          className="next-steps-confirm"
          role="group"
          aria-label={t("next_steps.confirm_label")}
          onKeyDown={(event) => {
            if (event.key === "Escape" && state !== "creating") {
              event.stopPropagation();
              cancel();
            }
          }}
        >
          <p className="next-steps-confirm-text" data-error={state === "failed" || undefined}>
            {state === "failed"
              ? t("next_steps.adopt_failed")
              : t("next_steps.confirm", { destination })}
          </p>
          <div className="next-steps-confirm-actions">
            <Button
              ref={confirmRef}
              type="button"
              size="dense"
              loading={state === "creating"}
              loadingLabel={t("next_steps.creating")}
              onClick={() => void create()}
            >
              {state === "failed" ? t("next_steps.retry") : t("next_steps.create")}
            </Button>
            <Button type="button" size="dense" variant="ghost" disabled={state === "creating"} onClick={cancel}>
              {t("next_steps.cancel")}
            </Button>
          </div>
        </div>
      ) : null}
    </>
  );
}
