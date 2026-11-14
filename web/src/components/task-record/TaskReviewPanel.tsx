"use client";

import { useId, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { getTaskReview, RelayApiError } from "../../api";
import { useRelayMutations } from "../../hooks/useRelayMutations";
import { artifactRawHref, formatArtifactDate } from "../../lib/artifactPreview";
import { pathForAppState } from "../../lib/appRoute";
import { Button } from "../ui/button";

/** A deliberate review snapshot: never silently refresh evidence underneath
 * someone making an acceptance decision. A changed revision requires a read. */
export function TaskReviewPanel({ taskId, onRequestChanges, onOpenThread, readOnly = false, compact = false, deferPrimary = false }: {
  taskId: string;
  onRequestChanges: () => void;
  onOpenThread?: (sessionId: string) => void;
  readOnly?: boolean;
  compact?: boolean;
  deferPrimary?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const { updateTaskMutation } = useRelayMutations();
  const [decisionError, setDecisionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const viewId = useId();
  const query = useQuery({
    // Each mounted surface owns its read. Opening another view of this task
    // must not replace evidence while someone is making a decision here.
    queryKey: ["task-review", taskId, viewId],
    queryFn: ({ signal }) => getTaskReview(taskId, signal),
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    // A remount must read again; an already open review stays fixed.
    staleTime: 0,
    retry: false,
  });
  const brief = query.data;
  const refresh = async () => {
    const result = await query.refetch();
    if (!result.isError) setDecisionError(null);
  };
  const accept = async () => {
    if (!brief?.canAccept || busy || decisionError || query.isFetching) return;
    setBusy(true);
    try {
      await updateTaskMutation.mutateAsync({ taskId, input: { status: "done", reviewRevision: brief.revision } });
    } catch (error) {
      setDecisionError(error instanceof RelayApiError && error.code === "task_review_changed"
        ? "task_review.changed" : "task_review.accept_failed");
    } finally {
      setBusy(false);
    }
  };

  const threadHref = brief?.sessionId ? pathForAppState({ route: "main", mobileView: "chat", sessionId: brief.sessionId }) : null;
  return (
    <section className={`task-review${compact ? " composer-slip task-review--compact" : ""}`} aria-label={t("task_review.title")} aria-busy={busy || query.isFetching}>
      <details open={!compact}>
        <summary>{t(compact ? "task_review.details" : "task_review.title")}</summary>
        {!brief && !query.isError ? <p role="status">{t("task_review.loading")}</p> : null}
        {brief ? <div className="task-review-body">
          <h3>{t("task_review.outcome")}</h3>
          <p className="task-review-goal">{brief.goal}</p>
          {brief.description ? <p className="task-review-text">{brief.description}</p> : null}
          <h3>{t("task_review.criteria")}</h3>
          {brief.criteria.length ? <ul>{brief.criteria.map((text, index) => <li key={index}>{text}</li>)}</ul> : <p>{t("task_review.criteria_missing")}</p>}
          <h3>{t("task_review.delivered")}</h3>
          {!brief.reports.length ? <p>{t("task_review.reports_missing")}</p> : null}
          {brief.reports.map((report) => <div className="task-review-report" key={report.runId}>
            <p className="task-review-attribution">
              <span title={report.agentId || undefined}>{report.agentName || report.agent || t("task_review.unknown_agent")}</span>
              {report.role ? ` · ${t(`project.roles.${report.role}`, { defaultValue: report.role })}` : null}
              {" · "}{t(`task_review.run_${report.status}`, { defaultValue: report.status })}
              {report.exitCode !== null ? ` · ${t("task_review.exit_code", { code: report.exitCode })}` : null}
            </p>
            {report.completedAt ? <p className="task-review-caption"><time dateTime={report.completedAt}>{formatArtifactDate(report.completedAt, i18n.language)}</time></p> : null}
            <p className="task-review-text">{report.note || t("task_review.summary_missing")}</p>
            <h4>{t("task_review.claims")}</h4>
            {report.evidence.length ? <ul>{report.evidence.map((text, index) => <li key={index}>{text}</li>)}</ul> : <p>{t("task_review.evidence_missing")}</p>}
            {report.findings.length ? <><h4>{t("task_review.issues")}</h4><ul>{report.findings.map((text, index) => <li key={index}>{text}</li>)}</ul></> : null}
            {report.workStatus && report.workStatus !== "done" ? <p>{t("task_review.unfinished", { status: report.workStatus })}</p> : null}
            {report.outputTruncated ? <p>{t("task_review.truncated")}</p> : null}
          </div>)}
          <h3>{t("task_review.validation")}</h3>
          <p>{t("task_review.verification_missing")}</p>
          <h3>{t("task_review.outputs")}</h3>
          {brief.artifacts.length ? <ul>{brief.artifacts.map((artifact) => <li key={`${artifact.sessionId}:${artifact.id}`}>
            {artifact.snapshotSkipped ? <span>{artifact.title} · {t("task_review.snapshot_missing")}</span> : (
              <a href={`${artifactRawHref(artifact.sessionId, artifact.id)}?snapshot=1`} target="_blank" rel="noopener noreferrer">{artifact.title}</a>
            )}
          </li>)}</ul> : <p>{t("task_review.artifacts_missing")}</p>}
          <p className="task-review-caption">{t("task_review.snapshot_notice")}</p>
          {brief.roundId ? <p className="task-review-caption">{t("task_review.round", { id: brief.roundId })}</p> : null}
          {threadHref && brief.sessionId ? <a href={threadHref} onClick={(event) => {
            if (!onOpenThread || event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
            event.preventDefault(); onOpenThread(brief.sessionId!);
          }}>{t("backlog.open_thread")}</a> : null}
        </div> : null}
      </details>
      {query.isError || decisionError ? <div className="task-review-error" role="alert">
        <span>{t(decisionError || "task_review.load_failed")}</span>
        <Button type="button" size="dense" variant="outline" disabled={query.isFetching || busy} onClick={() => void refresh()}>{t("task_review.refresh")}</Button>
      </div> : null}
      {brief && !readOnly ? <div className="task-review-actions">
        <Button type="button" size="dense" variant="ghost" disabled={busy || !brief.sessionId} onClick={onRequestChanges}>{t("thread.lifecycle.request_changes")}</Button>
        <Button type="button" size="dense" variant={deferPrimary ? "outline" : "default"} disabled={!brief.canAccept || busy || query.isFetching || query.isError || Boolean(decisionError)} loading={busy} onClick={() => void accept()}>{t("thread.lifecycle.accept")}</Button>
      </div> : null}
    </section>
  );
}
