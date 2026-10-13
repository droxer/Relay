"use client";

import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import type { RelayTaskListItem } from "../../types";

/**
 * Says why Relay paused an automation, wherever its owner might look for it,
 * and — when the surface passes `onResume` — offers Resume. Renders nothing for a
 * running automation or one its owner paused: those explain themselves
 * through the switch.
 */
export function AutomationPauseBanner({ task, className = "adm-form-hint", onResume, busy = false, resuming = false }: {
  task: Pick<RelayTaskListItem, "routineState" | "routinePauseReason">;
  /** The notice's chrome: a form hint in the drawer, a record notice on the page. */
  className?: string;
  /** Set only for a viewer who may resume it (see `canManageAutomation`). */
  onResume?: () => void;
  /** Another record action, or this one, is in flight. */
  busy?: boolean;
  resuming?: boolean;
}) {
  const { t } = useTranslation();
  if (task.routineState !== "paused_by_relay") return null;
  return (
    <div className={className} role="status">
      <p>{t(`automation.paused_reasons.${task.routinePauseReason ?? "rate_limited"}`)}</p>
      {onResume ? (
        <Button variant="outline" size="sm" disabled={busy} loading={resuming} onClick={onResume}>
          {t("automation.resume")}
        </Button>
      ) : null}
    </div>
  );
}
