"use client";

import { useQueries } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { WorkflowRun } from "relay-core";
import type { RelaySession } from "../../types";
import { getSession } from "../../api";
import { pathForAppState } from "../../lib/appRoute";
import { RELAY_POLL_INTERVALS_MS } from "../../lib/relayPolling";
import { taskWorkflowSessionQueryKey } from "../../lib/workflowRuns";
import { ThreadWorkflowSlip } from "../composer/WorkflowSlip";
import { DisclosureChevron, ICON } from "../icons";
import { WorkflowRunLedger, WorkflowRunSummary } from "../workflow/WorkflowProgress";
import { RecordFailure } from "./RecordFailure";

function isOpenRun(run: WorkflowRun): boolean {
  return run.status !== "completed" && run.status !== "cancelled";
}

/** Each execution owns its frozen ledger. Reading every linked Thread also
 *  preserves earlier failed/cancelled runs after a Task starts again. */
export function TaskWorkflowTimeline({ currentUserId, sessionIds, agentName, onOpenThread }: {
  currentUserId: string | undefined;
  sessionIds: readonly string[];
  agentName: (agentId: string) => string;
  onOpenThread?: (sessionId: string) => void;
}) {
  const { t } = useTranslation();
  const ids = [...new Set(sessionIds)];
  const queries = useQueries({ queries: ids.map(sessionId => ({
    queryKey: taskWorkflowSessionQueryKey(sessionId),
    queryFn: ({ signal }: { signal: AbortSignal }) => getSession(sessionId, signal),
    staleTime: RELAY_POLL_INTERVALS_MS.sessions,
    refetchInterval: (query: { state: { data?: RelaySession } }) => {
      const session = query.state.data;
      const settled = session && ["completed", "cancelled", "failed"].includes(session.status);
      return settled && !session.workflowRuns?.some(isOpenRun) ? false : RELAY_POLL_INTERVALS_MS.sessions;
    },
  })) });
  // The Thread links are appended in execution order. Preserve that order as
  // a fallback for old records with a missing or identical start time.
  const runs = queries.flatMap((query, index) => (query.data?.workflowRuns ?? []).map(run => ({
    run, sessionId: ids[index],
    canDecide: !query.isError && !!currentUserId && query.data?.ownerUserId === currentUserId
      && query.data.activeWorkflowRunId === run.workflowRunId,
  }))).reverse().sort((a, b) => (Date.parse(b.run.startedAt) || 0) - (Date.parse(a.run.startedAt) || 0));
  const active = runs.find(({ run }) => isOpenRun(run));
  const primary = active ?? runs[0];
  const history = runs.filter(entry => entry !== primary);
  const renderRun = (entry: (typeof runs)[number]) => (
    <TaskWorkflowRun key={entry.run.workflowRunId} run={entry.run} sessionId={entry.sessionId}
      showApproval={entry === active && entry.canDecide && entry.run.status === "awaiting_approval"}
      agentName={agentName} onOpenThread={onOpenThread} />
  );

  return <>
    {primary ? (
      <section className="record-workflow-timeline" aria-label={t("workflow.timeline_title")}>
        <h2 className="record-workflow-heading">{t(active ? "workflow.current_run" : "workflow.latest_run")}</h2>
        {renderRun(primary)}
        {history.length ? (
          <div className="record-workflow-history">
            <h3 className="record-workflow-heading">{t("workflow.run_history")}</h3>
            {history.map(renderRun)}
          </div>
        ) : null}
      </section>
    ) : null}
    {queries.map((query, index) => query.isError ? (
      <RecordFailure key={ids[index]} message={t("workflow.timeline_load_failed")} onRetry={() => { void query.refetch(); }} />
    ) : null)}
  </>;
}

function TaskWorkflowRun({ run, sessionId, showApproval, agentName, onOpenThread }: {
  run: WorkflowRun;
  sessionId: string;
  showApproval: boolean;
  agentName: (agentId: string) => string;
  onOpenThread?: (sessionId: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const started = new Date(run.startedAt);
  return (
    <article className="record-workflow-run">
      <WorkflowRunSummary run={run} agentName={agentName} />
      <div className="record-workflow-actions">
        {Number.isFinite(started.getTime()) ? (
          <time dateTime={run.startedAt}>{started.toLocaleString(i18n.language || undefined)}</time>
        ) : null}
        <a className="record-inline-action" href={pathForAppState({ route: "main", mobileView: "chat", sessionId })}
          onClick={event => {
            if (!onOpenThread || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
            event.preventDefault();
            onOpenThread(sessionId);
          }}>{t("backlog.open_thread")}</a>
      </div>
      {showApproval ? (
        <ThreadWorkflowSlip key={run.revision} sessionId={sessionId} run={run} focusOnMount={false} />
      ) : null}
      <details className="record-workflow-details">
        <summary>
          <span>{t("workflow.run_steps")}</span>
          <DisclosureChevron size={ICON.sm} className="record-workflow-chevron" aria-hidden="true" />
        </summary>
        <WorkflowRunLedger run={run} agentName={agentName} />
      </details>
    </article>
  );
}
