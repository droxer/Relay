import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { RelaySession, RelayTaskListItem } from "../types";
import { hrefForRoute, navigateToAppPath } from "../lib/appRoute";
import { executionRecoveryGuide, taskRecoveryGuide, type RecoveryGuide } from "../lib/executionRecovery";
import { Button, buttonVariants } from "@/components/ui/button";

/** Navigation out of the panel is a link, drawn with the shared link-button
 *  grammar: `data-slot="link-button"` is what a11y.css grows to the touch
 *  target on coarse pointers, and the variant keeps it the same control as
 *  every other wayfinding anchor (see RoutineDrawerMeta). */
function RecoveryLink({ href, onNavigate, children }: { href: string; onNavigate?: () => void; children: ReactNode }) {
  return (
    <a
      data-slot="link-button"
      className={buttonVariants({ variant: "ghost", size: "dense" })}
      href={href}
      onClick={event => {
        // No in-app handler means the href is the navigation: leave it alone,
        // as with a modified click the browser owns.
        if (!onNavigate || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        onNavigate();
      }}
    >
      {children}
    </a>
  );
}

function RecoveryDestination({ guide }: { guide: RecoveryGuide }) {
  const { t } = useTranslation();
  if (!guide.destination) return null;
  const href = hrefForRoute(guide.destination);
  return <RecoveryLink href={href} onNavigate={() => { void navigateToAppPath(href); }}>{t(`recovery.${guide.destination}`)}</RecoveryLink>;
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
  return <section className="recovery-panel" data-tone={guide.tone ?? "attention"} aria-label={t("recovery.title")}>
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
    {/* Mounted before it has anything to say: a polite live region inserted at
        the same moment as its text is not reliably announced. */}
    <p role="status" className="recovery-feedback">{feedback === "requested" ? t("recovery.retry_requested") : ""}</p>
  </section>;
}

export function TaskRecoveryPanel({ task, excludeSessionId, onOpenThread }: {
  task: RelayTaskListItem;
  /** A thread the surrounding surface already links (the routine drawer's own
   *  meta row). Suppressed here so one drawer never offers the same thread
   *  twice; a different blocking thread still gets its link. */
  excludeSessionId?: string;
  onOpenThread?: (sessionId: string) => void;
}) {
  const { t } = useTranslation();
  const guide = taskRecoveryGuide(task);
  if (!guide) return null;
  const linked = task.workspaceWaiting?.blockingSessionId || task.linkedSessionIds.at(-1);
  const sessionId = linked && linked !== excludeSessionId ? linked : undefined;
  const reason = task.status === "blocked" ? task.blockerReason : task.status === "assigned" && task.dispatchOutcome?.state !== "started" ? task.dispatchOutcome?.message : undefined;
  return <section className="recovery-panel" data-tone={guide.tone ?? "attention"} aria-label={t("recovery.title")}>
    <strong>{t(`recovery.${guide.key}.title`)}</strong>
    {reason ? <p className="recovery-context">{reason}</p> : null}
    <p>{t(`recovery.${guide.key}.body`)}</p>
    {task.status === "blocked" ? <p>{t("recovery.unblock_help")}</p> : null}
    <div className="recovery-actions">
      <RecoveryDestination guide={guide} />
      {sessionId ? (
        <RecoveryLink
          href={hrefForRoute("main", sessionId)}
          onNavigate={onOpenThread ? () => onOpenThread(sessionId) : undefined}
        >{t("recovery.thread")}</RecoveryLink>
      ) : null}
    </div>
  </section>;
}
