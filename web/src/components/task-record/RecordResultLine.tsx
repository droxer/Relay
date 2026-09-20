"use client";

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { listTaskRuns } from "../../api";
import { hrefForRoute } from "../../lib/appRoute";
import { formatRunDuration, runDurationMs, runOutcome } from "../../lib/taskRuns";
import type { TaskRun } from "../../types";

/**
 * The facts of one plain task's run: when it ended, how long it took, what it
 * left behind, and why it stopped if it stopped badly.
 *
 * It deliberately does NOT name the outcome. On the drawer it had to, because
 * nothing else did; on the record surface the band above already states the
 * status, and `RecordBand`'s contract is that no panel restates a band fact.
 *
 * A plain task ran as itself, so `/tasks/{id}/runs` answers with exactly one
 * row; a routine's many rows are `RecordRuns`' job.
 */
export function RecordResultLine({
  taskId,
  onOpenThread,
}: {
  taskId: string;
  onOpenThread?: (sessionId: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const [run, setRun] = useState<TaskRun | null | undefined>(undefined);

  useEffect(() => {
    const controller = new AbortController();
    setRun(undefined);
    listTaskRuns(taskId, { limit: 1 }, controller.signal)
      .then((response) => setRun(response.runs[0] ?? null))
      // A missing summary is not worth an error banner — the artifact list and
      // the timeline below it still answer the question, just less directly.
      .catch(() => {
        if (!controller.signal.aborted) setRun(null);
      });
    return () => controller.abort();
  }, [taskId]);

  if (!run) return null;

  const outcome = runOutcome(run);
  const duration = runDurationMs(run);
  const when = run.endedAt ?? run.startedAt;

  return (
    <section className="task-result-summary" data-outcome={outcome} aria-label={t("backlog.result_title")}>
      {when ? (
        <span className="task-result-when tnum">
          {new Intl.DateTimeFormat(i18n.language || undefined, {
            month: "short",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
          }).format(new Date(when))}
        </span>
      ) : null}
      {duration === null ? null : (
        <span className="task-result-duration tnum">{formatRunDuration(duration)}</span>
      )}
      {run.artifactCount > 0 ? (
        <span className="task-result-files tnum">
          {t("backlog.result_files", { count: run.artifactCount })}
        </span>
      ) : null}
      {run.failureMessage ? (
        <span className="task-result-reason">{run.failureMessage}</span>
      ) : null}
      {run.latestSessionId ? (
        <a
          className="task-drawer-artifact-download task-result-thread"
          href={hrefForRoute("main", run.latestSessionId)}
          onClick={(event) => {
            if (!onOpenThread) return;
            if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.altKey || event.ctrlKey || event.shiftKey) return;
            event.preventDefault();
            onOpenThread(run.latestSessionId as string);
          }}
        >
          {t("backlog.open_thread")}
        </a>
      ) : null}
    </section>
  );
}
