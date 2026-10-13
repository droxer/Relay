"use client";

import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { useRelayMutations } from "../../hooks/useRelayMutations";
import type { RelayTaskListItem } from "../../types";

/**
 * Says why Relay paused an automation, wherever its owner might look for it,
 * and — for its owner or an admin — offers Resume. Renders nothing for a
 * running automation or one its owner paused: those explain themselves
 * through the switch.
 */
export function AutomationPauseBanner({ task, className = "adm-form-hint", canResume = false, disabled = false }: {
  /** An unsaved draft has no id yet, and so nothing to resume. */
  task: Pick<RelayTaskListItem, "routineState" | "routinePauseReason"> & { id?: string };
  /** The notice's chrome: a form hint in the drawer, a record notice on the page. */
  className?: string;
  /** The viewer may resume it (see `canManageAutomation`). */
  canResume?: boolean;
  /** Another record action is in flight. */
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  if (task.routineState !== "paused_by_relay") return null;
  return (
    <div className={className} role="status">
      <p>{t(`automation.paused_reasons.${task.routinePauseReason ?? "rate_limited"}`)}</p>
      {canResume && task.id ? <ResumeAutomationButton taskId={task.id} disabled={disabled} /> : null}
    </div>
  );
}

/** Its own component so a banner without Resume (the edit drawer) mounts no
 *  mutations. */
function ResumeAutomationButton({ taskId, disabled }: { taskId: string; disabled: boolean }) {
  const { t } = useTranslation();
  const { resumeAutomationMutation } = useRelayMutations();
  return (
    <Button
      variant="outline"
      size="sm"
      disabled={disabled || resumeAutomationMutation.isPending}
      onClick={() => {
        // The mutation's onError raises the toast; the button comes back.
        resumeAutomationMutation.mutateAsync({ taskId }).catch(() => undefined);
      }}
    >
      {t("automation.resume")}
    </Button>
  );
}
