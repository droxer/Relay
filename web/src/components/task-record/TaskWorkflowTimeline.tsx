"use client";

import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { WorkflowRun } from "relay-core";
import { getTaskWorkflowHistory, getThreadWorkflow, RelayApiError, type ThreadWorkflow } from "../../api";
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
export function TaskWorkflowTimeline({ taskId, currentUserId, sessionIds, agentName, agentImage, onOpenThread }: {
  taskId: string;
  currentUserId: string | undefined;
  sessionIds: readonly string[];
  agentName: (agentId: string) => string;
  agentImage?: (agentId: string) => string | null | undefined;
  onOpenThread?: (sessionId: string) => void;
}) {
  const { t } = useTranslation();
  const client = useQueryClient();
  const ids = [...new Set(sessionIds)];
  const historyQuery = useQuery({
    queryKey: ["task-workflow-history", taskId, ids],
    enabled: ids.length > 0,
    staleTime: RELAY_POLL_INTERVALS_MS.sessions,
    queryFn: async ({ signal }) => {
      const revisions = new Map(ids.map(id => [id, client.getQueryState(taskWorkflowSessionQueryKey(id))?.dataUpdateCount]));
      try {
        const { threads } = await getTaskWorkflowHistory(taskId, signal);
        if (!signal.aborted) {
          for (const thread of threads) {
            const key = taskWorkflowSessionQueryKey(thread.id);
            const before = client.getQueryState(key);
            // A gate decision or a live Thread poll may have started while history was loading.
            if (revisions.has(thread.id) && before?.dataUpdateCount === revisions.get(thread.id)
              && !before?.isInvalidated && before?.fetchStatus !== "fetching") client.setQueryData(key, thread);
          }
        }
        return threads.map(thread => thread.id);
      } catch (error) {
        if (error instanceof RelayApiError && error.status === 404) return null;
        throw error;
      }
    },
  });
  const present = new Set(historyQuery.data ?? []);
  const readable = historyQuery.data === null ? ids : ids.filter(id => present.has(id));
  const queries = useQueries({ queries: readable.map(sessionId => ({
    queryKey: taskWorkflowSessionQueryKey(sessionId),
    queryFn: ({ signal }: { signal: AbortSignal }) => getThreadWorkflow(sessionId, signal),
    staleTime: RELAY_POLL_INTERVALS_MS.sessions,
    refetchOnMount: (query: { state: { isInvalidated: boolean } }) => historyQuery.data === null || query.state.isInvalidated,
    refetchInterval: (query: { state: { data?: ThreadWorkflow } }) => {
      const session = query.state.data;
      const settled = session && ["completed", "cancelled", "failed"].includes(session.status);
      return settled && !session.workflowRuns?.some(isOpenRun) ? false : RELAY_POLL_INTERVALS_MS.sessions;
    },
  })) });
  // The Thread links are appended in execution order. Preserve that order as
  // a fallback for old records with a missing or identical start time.
  const runs = queries.flatMap((query, index) => (query.data?.workflowRuns ?? []).map(run => ({
    run, sessionId: readable[index],
    canDecide: !query.isError && !!currentUserId && query.data?.ownerUserId === currentUserId
      && query.data.activeWorkflowRunId === run.workflowRunId,
  }))).reverse().sort((a, b) => (Date.parse(b.run.startedAt) || 0) - (Date.parse(a.run.startedAt) || 0));
  const active = runs.find(({ run }) => isOpenRun(run));
  const primary = active ?? runs[0];
  const history = runs.filter(entry => entry !== primary);
  const renderRun = (entry: (typeof runs)[number]) => (
    <TaskWorkflowRun key={entry.run.workflowRunId} run={entry.run} sessionId={entry.sessionId}
      showApproval={entry === active && entry.canDecide && entry.run.status === "awaiting_approval"}
      agentName={agentName} agentImage={agentImage} onOpenThread={onOpenThread} />
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
    {historyQuery.isError || (historyQuery.data && readable.length !== ids.length) ? (
      <RecordFailure message={t("workflow.timeline_load_failed")} onRetry={() => { void historyQuery.refetch(); }} />
    ) : null}
    {queries.map((query, index) => query.isError ? (
      <RecordFailure key={readable[index]} message={t("workflow.timeline_load_failed")} onRetry={() => { void query.refetch(); }} />
    ) : null)}
  </>;
}

function TaskWorkflowRun({ run, sessionId, showApproval, agentName, agentImage, onOpenThread }: {
  run: WorkflowRun;
  sessionId: string;
  showApproval: boolean;
  agentName: (agentId: string) => string;
  agentImage?: (agentId: string) => string | null | undefined;
  onOpenThread?: (sessionId: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const started = new Date(run.startedAt);
  return (
    <article className="record-workflow-run">
      <WorkflowRunSummary run={run} agentName={agentName} agentImage={agentImage} />
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
        <WorkflowRunLedger run={run} agentName={agentName} agentImage={agentImage} />
      </details>
    </article>
  );
}
