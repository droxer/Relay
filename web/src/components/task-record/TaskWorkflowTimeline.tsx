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
import { WorkflowProgress } from "../workflow/WorkflowProgress";
import { RecordFailure } from "./RecordFailure";

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
    refetchInterval: (query: { state: { data?: RelaySession } }) =>
      query.state.data && ["completed", "cancelled", "failed"].includes(query.state.data.status)
        && !query.state.data.workflowRuns?.some((run: WorkflowRun) => run.status !== "completed" && run.status !== "cancelled")
        ? false : RELAY_POLL_INTERVALS_MS.sessions,
  })) });
  return <>
    {queries.map((query, index) => {
      const sessionId = ids[index];
      if (query.isError) return <RecordFailure key={sessionId} message={t("workflow.timeline_load_failed")} onRetry={() => { void query.refetch(); }} />;
      const runs = query.data?.workflowRuns ?? [];
      if (!runs.length) return null;
      return <section key={sessionId} className="record-workflow-timeline" aria-label={t("workflow.timeline_title")}>
        {runs.map(run => <div key={run.workflowRunId}>
          <WorkflowProgress run={run} agentName={agentName} expanded />
          {!query.isError && currentUserId && query.data?.ownerUserId === currentUserId
            && query.data.activeWorkflowRunId === run.workflowRunId && run.status === "awaiting_approval" ? (
              <ThreadWorkflowSlip key={run.revision} sessionId={sessionId} run={run} focusOnMount={false} />
            ) : null}
        </div>)}
        <a className="record-inline-action" href={pathForAppState({ route: "main", mobileView: "chat", sessionId })}
          onClick={event => {
            if (!onOpenThread || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
            event.preventDefault();
            onOpenThread(sessionId);
          }}>{t("backlog.open_thread")}</a>
      </section>;
    })}
  </>;
}
