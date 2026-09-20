"use client";

import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { listTaskRuns } from "../../api";
import { RELAY_POLL_INTERVALS_MS } from "../../lib/relayPolling";
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
  /* Cached like the rest of the record. A missing summary is still not worth
     an error banner — the artifact list and the timeline below it answer the
     same question, just less directly — so this one stays silent on failure
     rather than joining `RecordFailure`. */
  const { data } = useQuery({
    queryKey: ["task-runs", taskId, 1],
    queryFn: ({ signal }) => listTaskRuns(taskId, { limit: 1 }, signal),
    staleTime: RELAY_POLL_INTERVALS_MS.tasks,
  });
  const run: TaskRun | undefined = data?.runs[0];

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
          className="record-inline-action task-result-thread"
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
