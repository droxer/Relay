import { useTranslation } from "react-i18next";
import type { RelaySession } from "../types";
import { threadAwaitsHuman } from "../lib/awaitingInput";
import { Badge } from "./ui/badge";
import { NavThreads } from "./icons";

/** Conversation activity, independent of a task's persistent workflow. An
 * answered conversation is ready for another message, rather than done. */
function threadActivityState(session: RelaySession) {
  const phase = session.execution?.phase;
  return phase && phase !== "terminal" && phase !== "running" ? phase
    : threadAwaitsHuman(session, []) ? "waiting_for_human"
    : phase === "running" || (!phase && session.status === "running") ? "running"
    : session.status === "failed" ? "failed"
    : session.status === "cancelled" ? "cancelled" : "ready";
}

export function threadStatusLabelKey(session: RelaySession): string {
  const state = threadActivityState(session);
  return state === "ready" ? "thread.status_ready"
    : ["queued", "running", "stopping", "unresponsive", "finalizing", "recovery_required"].includes(state)
      ? `thread.execution_${state}` : `thread.statuses.${state}`;
}

export function ThreadStatusBadge({ session, compact = false }: {
  session: RelaySession;
  compact?: boolean;
}) {
  const { t } = useTranslation();
  const state = threadActivityState(session);
  const variant = state === "failed" || state === "recovery_required" || state === "unresponsive" ? "danger"
    : state === "waiting_for_human" || state === "stopping" ? "warning"
    : state === "running" || state === "finalizing" ? "info" : "neutral";
  const label = t(threadStatusLabelKey(session));
  return (
    <Badge
      className="thread-status-badge"
      variant={variant}
      size={compact ? "compact" : "default"}
      data-state={state}
      title={label}
    >
      <NavThreads aria-hidden="true" />
      {label}
    </Badge>
  );
}
