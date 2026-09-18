import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { RelaySession, RelayTaskListItem } from "../types";
import { hrefForRoute, navigateToAppPath } from "../lib/appRoute";
import { executionRecoveryGuide, taskRecoveryGuide, type RecoveryGuide } from "../lib/executionRecovery";
import { Button } from "@/components/ui/button";

function RecoveryDestination({ guide }: { guide: RecoveryGuide }) {
  const { t } = useTranslation();
  return guide.destination ? <a href={hrefForRoute(guide.destination)} onClick={event => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault(); void navigateToAppPath(hrefForRoute(guide.destination!));
  }}>{t(`recovery.${guide.destination}`)}</a> : null;
}

export function ExecutionRecoveryPanel({ session, onRetry }: { session: RelaySession; onRetry?: () => Promise<void> }) {
  const guide = executionRecoveryGuide(session.execution);
  // Remount feedback when switching threads or when reconciliation changes the reason.
  return guide ? <ExecutionRecoveryContent key={`${session.id}:${guide.key}`} session={session} guide={guide} onRetry={onRetry} /> : null;
}

function ExecutionRecoveryContent({ session, guide, onRetry }: { session: RelaySession; guide: RecoveryGuide; onRetry?: () => Promise<void> }) {
  const { t } = useTranslation();
  const [feedback, setFeedback] = useState<"idle" | "pending" | "failed" | "requested">("idle");
  const execution = session.execution!;
  const computer = session.computerId || session.managedNodeId || session.daemonNodeId;
  return <section className="recovery-panel" aria-label={t("recovery.title")}>
    <strong>{t(`recovery.${guide.key}.title`)}</strong>
    <p>{t(`recovery.${guide.key}.body`)}</p>
    {computer ? <p className="recovery-context">{t("recovery.host", { computer })}</p> : null}
    {execution.deletionRequested ? <p>{t("recovery.deletion_pending")}</p> : null}
    <div className="recovery-actions">
      {guide.key === "finalization_failed" && onRetry ? <Button type="button" variant="outline" size="dense" disabled={feedback === "pending"} onClick={async () => {
        setFeedback("pending");
        try { await onRetry(); setFeedback("requested"); }
        catch { setFeedback("failed"); }
      }}>{t(feedback === "pending" ? "recovery.retrying" : "recovery.retry")}</Button> : null}
      <RecoveryDestination guide={guide} />
    </div>
    {feedback === "failed" ? <p role="alert">{t("recovery.action_failed")}</p> : null}
    {feedback === "requested" ? <p role="status">{t("recovery.retry_requested")}</p> : null}
  </section>;
}

export function TaskRecoveryPanel({ task, onOpenThread }: { task: RelayTaskListItem; onOpenThread?: (sessionId: string) => void }) {
  const { t } = useTranslation();
  const guide = taskRecoveryGuide(task);
  if (!guide) return null;
  const sessionId = task.workspaceWaiting?.blockingSessionId || task.linkedSessionIds.at(-1);
  const reason = task.status === "blocked" ? task.blockerReason : task.status === "assigned" && task.dispatchOutcome?.state !== "started" ? task.dispatchOutcome?.message : undefined;
  return <section className="recovery-panel" aria-label={t("recovery.title")}>
    <strong>{t(`recovery.${guide.key}.title`)}</strong>
    {reason ? <p className="recovery-context">{reason}</p> : null}
    <p>{t(`recovery.${guide.key}.body`)}</p>
    {task.status === "blocked" ? <p>{t("recovery.unblock_help")}</p> : null}
    <div className="recovery-actions">
      <RecoveryDestination guide={guide} />
      {sessionId ? <a href={hrefForRoute("main", sessionId)} onClick={event => {
        if (!onOpenThread || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault(); onOpenThread(sessionId);
      }}>{t("recovery.thread")}</a> : null}
    </div>
  </section>;
}
