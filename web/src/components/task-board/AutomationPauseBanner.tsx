"use client";

import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { RelayTaskListItem } from "../../types";

/**
 * Says why Relay paused an automation, wherever its owner might look for it.
 * Renders nothing for a running automation or one its owner paused: those
 * explain themselves through the switch.
 */
export function AutomationPauseBanner({ task, className = "adm-form-hint", children }: {
  task: Pick<RelayTaskListItem, "routineState" | "routinePauseReason">;
  /** The notice's chrome: a form hint in the drawer, a record notice on the page. */
  className?: string;
  /** An action beside the reason, e.g. the record page's Re-enable. */
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  if (task.routineState !== "paused_by_relay") return null;
  return (
    <div className={className} role="status">
      <p>{t(`automation.paused_reasons.${task.routinePauseReason ?? "rate_limited"}`)}</p>
      {children}
    </div>
  );
}
