import { useTranslation } from "react-i18next";
import type { RelaySession } from "../types";
import { threadAwaitsHuman } from "../lib/awaitingInput";
import { shownExecutionPhase, type QueueReading } from "../lib/queuedRun";
import { Badge } from "./ui/badge";
import { NavThreads } from "./icons";

/** Conversation activity, independent of a task's persistent workflow. An
 * answered conversation is ready for another message, rather than done. */
function threadActivityState(session: RelaySession, reading: QueueReading) {
  const phase = shownExecutionPhase(session, reading);
  return phase && phase !== "terminal" && phase !== "running" ? phase
    : threadAwaitsHuman(session, []) ? "waiting_for_human"
    : phase === "running" || (!phase && session.status === "running") ? "running"
    : session.status === "failed" ? "failed"
    : session.status === "cancelled" ? "cancelled" : "ready";
}

export function threadStatusLabelKey(session: RelaySession, reading: QueueReading = {}): string {
  const state = threadActivityState(session, reading);
  return state === "ready" ? "thread.status_ready"
    : ["queued", "running", "stopping", "unresponsive", "finalizing", "recovery_required"].includes(state)
      ? `thread.execution_${state}` : `thread.statuses.${state}`;
}

export function ThreadStatusBadge({ session, compact = false, iconOnly = false, reading = {} }: {
  session: RelaySession;
  /** The clock and computer liveness a queued run's grace is read against;
   * without them the badge shows the backend's phase as is. */
  reading?: QueueReading;
  compact?: boolean;
  /** Draw only the tinted mark, for a row whose own text already states the
   * status: the label stays as the badge's tooltip and accessible name. */
  iconOnly?: boolean;
}) {
  const { t } = useTranslation();
  const state = threadActivityState(session, reading);
  const variant = state === "failed" || state === "recovery_required" || state === "unresponsive" ? "danger"
    : state === "waiting_for_human" || state === "stopping" ? "warning"
    : state === "running" || state === "finalizing" ? "info" : "neutral";
  const label = t(threadStatusLabelKey(session, reading));
  return (
    <Badge
      className="thread-status-badge"
      variant={variant}
      size={compact ? "compact" : "default"}
      data-state={state}
      data-icon-only={iconOnly ? "true" : undefined}
      title={label}
    >
      <NavThreads aria-hidden="true" />
      {iconOnly ? <span className="sr-only">{label}</span> : label}
    </Badge>
  );
}
