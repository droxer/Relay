"use client";

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import { ComputerDeviceSetup } from "../computer/ComputerDeviceSetup";
import { ConnectComputerDrawer } from "../computer/ConnectComputerDrawer";
import { CreateAgentDialog } from "../agents/CreateAgentDialog";
import { ActionPrompt, ICON, NavAgents, NavComputer, NavThreads, StatusOk, XIcon } from "../icons";
import { agentLabel } from "../../lib/plan";
import type { OnboardingProgress, OnboardingStep, OnboardingTarget } from "../../lib/onboarding";
import type { AppRoute } from "../../lib/viewTypes";
import type { OnboardingCard } from "../../types";

/* One body per wizard step. Each wraps a flow the app already has — the
   device setup command, the agent dialog, the composer — rather than a copy
   of it, so the wizard can never drift from the real thing. */

const CARD_ROUTES: Record<OnboardingCard, AppRoute> = {
  tasks: "backlog",
  projects: "projects",
  teams: "teams",
  automations: "routine",
};

export function IntroStep({ onStart, onDismiss }: { onStart: () => void; onDismiss: () => void }) {
  const { t } = useTranslation();
  const parts = [
    { key: "relay", Icon: NavThreads },
    { key: "computer", Icon: NavComputer },
    { key: "agents", Icon: NavAgents },
  ] as const;
  return (
    <>
      <ul className="onboarding-model">
        {parts.map(({ key, Icon }) => (
          <li key={key}>
            <span className="onboarding-model-mark" aria-hidden="true"><Icon size={ICON.md} /></span>
            <span>
              <strong>{t(`onboarding.intro.${key}_title`)}</strong>{" "}
              {t(`onboarding.intro.${key}_body`)}
            </span>
          </li>
        ))}
      </ul>
      <div className="onboarding-actions">
        <Button type="button" onClick={onStart}>{t("onboarding.intro.start")}</Button>
        <Button type="button" variant="ghost" onClick={onDismiss}>{t("onboarding.intro.skip")}</Button>
      </div>
    </>
  );
}

function ConnectedComputer({ progress }: { progress: OnboardingProgress }) {
  const { t } = useTranslation();
  if (!progress.computer || !progress.done.computer) return null;
  return (
    <p className="onboarding-fact">
      <StatusOk size={ICON.sm} aria-hidden="true" />
      {t("onboarding.computer.connected", {
        name: progress.computer.name,
        runtimes: progress.computer.readyRuntimes.map(agentLabel).join(", "),
      })}
    </p>
  );
}

/** A later step reached before the one it needs: say which, and go back. */
function Prerequisite({ step, onView }: { step: OnboardingStep; onView: (step: OnboardingStep) => void }) {
  const { t } = useTranslation();
  return (
    <p className="onboarding-hint">
      {t(`onboarding.needs.${step}`)}{" "}
      <button type="button" className="onboarding-link" onClick={() => onView(step)}>
        {t("onboarding.needs.go_back")}
      </button>
    </p>
  );
}

export function ComputerStep({
  progress,
  onView,
  onOpenComputers,
  onChanged,
}: {
  progress: OnboardingProgress;
  onView: (step: OnboardingStep) => void;
  onOpenComputers: () => void;
  onChanged: () => void;
}) {
  const { t } = useTranslation();
  const [manualOpen, setManualOpen] = useState(false);
  if (progress.done.computer) {
    return (
      <>
        <ConnectedComputer progress={progress} />
        <div className="onboarding-actions">
          <Button type="button" onClick={() => onView("agent")}>{t("onboarding.next")}</Button>
        </div>
      </>
    );
  }
  if (progress.blocked === "computer_limit") {
    return <Alert>{t("onboarding.computer.limit")}</Alert>;
  }
  if (progress.blocked === "no_ready_runtime") {
    return (
      <>
        <Alert>{t("onboarding.computer.no_runtime", { name: progress.computer?.name ?? "" })}</Alert>
        <div className="onboarding-actions">
          <Button type="button" variant="outline" onClick={onOpenComputers}>
            {t("onboarding.computer.open_settings")}
          </Button>
        </div>
      </>
    );
  }
  return (
    <>
      <ComputerDeviceSetup onManual={() => setManualOpen(true)} />
      <p className="onboarding-waiting">
        <span className="onboarding-waiting-dot" aria-hidden="true" />
        {t("onboarding.computer.waiting")}
      </p>
      <div className="onboarding-actions">
        <Button type="button" variant="ghost" onClick={() => onView("agent")}>{t("onboarding.skip_step")}</Button>
      </div>
      <ConnectComputerDrawer
        open={manualOpen}
        onClose={() => setManualOpen(false)}
        onConnected={() => onChanged()}
      />
    </>
  );
}

export function AgentStep({
  progress,
  userId,
  onView,
  onChanged,
}: {
  progress: OnboardingProgress;
  userId: string;
  onView: (step: OnboardingStep) => void;
  onChanged: () => void;
}) {
  const { t } = useTranslation();
  const [createOpen, setCreateOpen] = useState(false);
  return (
    <>
      {progress.done.computer ? <ConnectedComputer progress={progress} /> : <Prerequisite step="computer" onView={onView} />}
      <div className="onboarding-actions">
        {progress.done.agent ? (
          <Button type="button" onClick={() => onView("thread")}>{t("onboarding.next")}</Button>
        ) : (
          <Button type="button" onClick={() => setCreateOpen(true)}>{t("onboarding.agent.create")}</Button>
        )}
        {!progress.done.agent ? (
          <Button type="button" variant="ghost" onClick={() => onView("thread")}>{t("onboarding.skip_step")}</Button>
        ) : null}
      </div>
      <CreateAgentDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        userId={userId}
        onCreated={() => {
          setCreateOpen(false);
          onChanged();
        }}
      />
    </>
  );
}

export function ThreadStep({
  progress,
  onView,
  onUseStarter,
}: {
  progress: OnboardingProgress;
  onView: (step: OnboardingStep) => void;
  onUseStarter: (text: string, target?: OnboardingTarget) => void;
}) {
  const { t } = useTranslation();
  const starter = t("onboarding.thread.starter");
  return (
    <>
      {!progress.done.agent ? <Prerequisite step="agent" onView={onView} /> : null}
      <Button
        type="button"
        variant="outline"
        className="onboarding-starter"
        onClick={() => onUseStarter(starter, progress.computer && progress.agent
          ? { nodeId: progress.computer.id, agent: progress.agent }
          : undefined)}
      >
        <span className="onboarding-starter-label">
          {t("onboarding.thread.starter_label")}
          <ActionPrompt size={ICON.xs} aria-hidden="true" />
        </span>
        <span className="onboarding-starter-text">{starter}</span>
      </Button>
      <p className="onboarding-hint">{t("onboarding.thread.hint")}</p>
    </>
  );
}

export function ExploreStep({
  progress,
  onOpenRoute,
  onCloseCard,
  onDone,
}: {
  progress: OnboardingProgress;
  onOpenRoute: (route: AppRoute) => void;
  onCloseCard: (card: OnboardingCard) => void;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      <ul className="onboarding-cards">
        {progress.openCards.map((card) => (
          <li key={card} className="onboarding-card">
            <div className="onboarding-card-copy">
              <h4>{t(`onboarding.explore.${card}_title`)}</h4>
              <p>{t(`onboarding.explore.${card}_body`)}</p>
            </div>
            <div className="onboarding-card-actions">
              <Button type="button" variant="outline" size="dense" onClick={() => onOpenRoute(CARD_ROUTES[card])}>
                {t("onboarding.explore.open")}
              </Button>
              <Button
                type="button"
                variant="icon"
                size="icon-dense"
                aria-label={t("onboarding.explore.close", { name: t(`onboarding.explore.${card}_title`) })}
                onClick={() => onCloseCard(card)}
              >
                <XIcon size={ICON.sm} />
              </Button>
            </div>
          </li>
        ))}
      </ul>
      <div className="onboarding-actions">
        <Button type="button" onClick={onDone}>{t("onboarding.explore.done")}</Button>
      </div>
    </>
  );
}
