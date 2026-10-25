"use client";

import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { ActionSend, ICON } from "./icons";

/**
 * What the agent suggests asking next, under its finished turn.
 *
 * Each is a complete request in the person's own voice, so one click sends it
 * as the next message — the same contract as an offered answer. They are
 * offers, not the agent's words: quiet outline rows that light up on intent,
 * and gone as soon as anything new happens in the thread.
 */
export function NextSteps({ steps, onSend }: {
  steps: readonly string[];
  /** Send this as the next message; resolves false when it was not sent. */
  onSend: (text: string) => Promise<boolean>;
}) {
  const { t } = useTranslation();
  const headingId = useId();
  const [sending, setSending] = useState<string | null>(null);
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
  return (
    <section className="next-steps" aria-labelledby={headingId}>
      <h2 id={headingId} className="next-steps-title">{t("next_steps.title")}</h2>
      <ul className="next-steps-list">
        {steps.map((step) => (
          <li key={step}>
            <button
              type="button"
              className="next-steps-item"
              data-sending={sending === step || undefined}
              disabled={sending !== null}
              aria-busy={sending === step || undefined}
              onClick={() => void send(step)}
            >
              <span className="next-steps-label">{step}</span>
              <ActionSend className="next-steps-send" size={ICON.sm} aria-hidden="true" />
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
