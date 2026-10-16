"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useKeyChange } from "../../hooks/useKeyChange";
import { ICON, StatusOk } from "../icons";
import { SETUP_STEPS, type OnboardingStep, type OnboardingTarget } from "../../lib/onboarding";
import type { OnboardingControls } from "../../hooks/useOnboarding";
import type { AppRoute } from "../../lib/viewTypes";
import { cn } from "@/lib/utils";
import { AgentStep, ComputerStep, ExploreStep, IntroStep, ThreadStep } from "./OnboardingSteps";

type OnboardingPanelProps = {
  controls: OnboardingControls;
  userId: string;
  /** Drops a prompt into the composer below and focuses it. */
  onUseStarter: (text: string, target?: OnboardingTarget) => void;
  onOpenRoute: (route: AppRoute) => void;
  /** Opens Settings → Computers, where runtimes are refreshed. */
  onOpenComputers: () => void;
  /** Something the wizard created should show up now, not on the next poll. */
  onChanged: () => void;
};

/**
 * The onboarding wizard, in the space the empty transcript otherwise holds.
 * The step shown is the first unfinished one unless the person picked
 * another; when real progress moves the wizard on, it says so politely and
 * moves focus to the new step's heading — never into a form.
 * See docs/onboarding-wizard-design.md.
 */
export function OnboardingPanel({
  controls,
  userId,
  onUseStarter,
  onOpenRoute,
  onOpenComputers,
  onChanged,
}: OnboardingPanelProps) {
  const { t } = useTranslation();
  const { progress, start, dismiss, closeCard } = controls;
  const headingId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [picked, setPicked] = useState<OnboardingStep | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const focusedStep = useRef(progress.step);
  const shown = picked ?? progress.step;

  // Real progress outranks a manual pick: finishing a step lands on the next.
  useKeyChange(progress.step, (next, previous) => {
    setPicked(null);
    if (previous !== "intro") setAnnouncement(t(`onboarding.announce.${next}`));
  });
  // Follow the advance with focus, but not on first paint: landing on the
  // home screen should not yank focus out of the composer.
  useEffect(() => {
    if (focusedStep.current === progress.step) return;
    focusedStep.current = progress.step;
    headingRef.current?.focus();
  }, [progress.step]);

  const view = (step: OnboardingStep) => {
    setPicked(step);
    headingRef.current?.focus();
  };

  const body = (() => {
    switch (shown) {
      case "intro":
        return <IntroStep onStart={start} onDismiss={dismiss} />;
      case "computer":
        return <ComputerStep progress={progress} onView={view} onOpenComputers={onOpenComputers} onChanged={onChanged} />;
      case "agent":
        return <AgentStep progress={progress} userId={userId} onView={view} onChanged={onChanged} />;
      case "thread":
        return <ThreadStep progress={progress} onView={view} onUseStarter={onUseStarter} />;
      case "explore":
        return <ExploreStep progress={progress} onOpenRoute={onOpenRoute} onCloseCard={closeCard} onDone={dismiss} />;
    }
  })();

  return (
    <section className="onboarding" aria-labelledby={headingId}>
      <p className="onboarding-eyebrow">
        {t("onboarding.eyebrow")}
        {shown !== "intro" ? (
          <span className="onboarding-count">
            {t("onboarding.count", { done: progress.completedCount, total: SETUP_STEPS.length })}
          </span>
        ) : null}
      </p>
      {shown !== "intro" ? (
        <ol className="onboarding-steps">
          {SETUP_STEPS.map((step, index) => (
            <li key={step}>
              <button
                type="button"
                className={cn("onboarding-step", progress.done[step] && "is-done")}
                aria-current={shown === step ? "step" : undefined}
                onClick={() => view(step)}
              >
                <span className="onboarding-step-mark" aria-hidden="true">
                  {progress.done[step] ? <StatusOk size={ICON.xs} /> : index + 1}
                </span>
                <span className="onboarding-step-label">{t(`onboarding.${step}.label`)}</span>
                {progress.done[step] ? <span className="sr-only">{t("onboarding.step_done")}</span> : null}
              </button>
            </li>
          ))}
        </ol>
      ) : null}
      <h2 id={headingId} ref={headingRef} className="onboarding-title" tabIndex={-1}>
        {t(`onboarding.${shown}.title`)}
      </h2>
      <p className="onboarding-body">{t(`onboarding.${shown}.body`)}</p>
      <div className="onboarding-content">{body}</div>
      {shown !== "intro" && shown !== "explore" ? (
        <p className="onboarding-footer">
          <button type="button" className="onboarding-link" onClick={dismiss}>
            {t("onboarding.hide")}
          </button>
          <span>{t("onboarding.hide_hint")}</span>
        </p>
      ) : null}
      <p className="sr-only" role="status" aria-live="polite">{announcement}</p>
    </section>
  );
}
