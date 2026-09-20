"use client";

import { useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { listTaskRuns } from "../../api";
import { RecordFailure } from "./RecordFailure";
import { RELAY_POLL_INTERVALS_MS } from "../../lib/relayPolling";
import { formatRunDuration, runDurationMs, runOutcome, type RunOutcome } from "../../lib/taskRuns";
import type { TaskRun } from "../../types";
import { StateMark, type StateTone } from "../StateMark";

/**
 * A routine's runs, as a list of destinations.
 *
 * A routine is a definition — it never runs itself, so its runs live in
 * promoted occurrences. Each one is a real task with its own events, files
 * and threads, which is why a row here is a link to that record rather than
 * an accordion: the drawer used to unfold an event list inside a row inside a
 * form inside an overlay, and two runs could never be compared or linked to.
 *
 * There is deliberately no summary strip above this list. "24 runs, 3 failed"
 * is the band that was deleted from the routine board for restating figures
 * the rows already carry; a failure's reason belongs on the failing row,
 * which is where people look for it.
 */

/** How many runs the ledger asks for before the reader asks for more. */
const RUN_PAGE_SIZE = 25;

/** Outcome → the tone half of the state vocabulary; `StateMark` picks the shape. */
const TONE_FOR_OUTCOME: Record<RunOutcome, StateTone> = {
  done: "good",
  failed: "bad",
  running: "live",
  pending: "neutral",
};

function isTerminal(run: TaskRun): boolean {
  const outcome = runOutcome(run);
  return outcome === "done" || outcome === "failed";
}

function runDate(value: string | null | undefined, locale: string): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(locale || undefined, { month: "short", day: "numeric" }).format(date);
}

function runTime(value: string | null, locale: string): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(locale || undefined, { hour: "2-digit", minute: "2-digit" }).format(date);
}

export function RecordRuns({
  taskId,
  hrefForRun,
  onOpenRun,
}: {
  taskId: string;
  hrefForRun: (runTaskId: string) => string;
  onOpenRun: (runTaskId: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const [limit, setLimit] = useState(RUN_PAGE_SIZE);

  /* Through the query cache, like every other read in the app: a tab switch
     re-renders this panel from cache instead of refetching the ledger, and
     "show earlier" widens the ask without the list going back to a spinner
     (`keepPreviousData`) — it used to blank itself on every click. */
  const runsQuery = useQuery({
    queryKey: ["task-runs", taskId, limit],
    queryFn: ({ signal }) => listTaskRuns(taskId, { limit }, signal),
    placeholderData: keepPreviousData,
    // Tab panels unmount on switch and the tab strip activates on arrow keys,
    // so without a staleness horizon surfing the tabs refires every panel's
    // request per keystroke. One poll interval is how fresh the rest of the
    // record is anyway.
    staleTime: RELAY_POLL_INTERVALS_MS.tasks,
    // A routine whose last run finished in March has nothing to poll for; one
    // with a run in flight is watched until it lands.
    refetchInterval: (query) =>
      query.state.data?.runs.some((run) => !isTerminal(run)) ? RELAY_POLL_INTERVALS_MS.tasks : false,
  });
  const runs = runsQuery.data?.runs;

  if (runsQuery.isError) {
    return <RecordFailure message={t("backlog.runs.error")} onRetry={() => void runsQuery.refetch()} />;
  }
  if (!runs) {
    return <p className="record-empty" role="status" aria-live="polite">{t("backlog.runs.loading")}</p>;
  }
  if (runs.length === 0) {
    return <p className="record-empty">{t("backlog.runs.empty")}</p>;
  }

  return (
    <>
      <ol className="record-run-list">
        {runs.map((run) => (
          <RunRow
            key={run.taskId}
            run={run}
            locale={i18n.language}
            href={hrefForRun(run.taskId)}
            onOpen={() => onOpenRun(run.taskId)}
          />
        ))}
      </ol>
      {/* The runs endpoint caps a page and has no cursor, so "earlier" is a
          larger ask rather than a next page. */}
      {runs.length >= limit ? (
        <button
          type="button"
          className="record-run-more"
          disabled={runsQuery.isFetching}
          onClick={() => setLimit((current) => current + RUN_PAGE_SIZE)}
        >
          {t("record.runs_show_earlier")}
        </button>
      ) : null}
    </>
  );
}

function RunRow({
  run,
  locale,
  href,
  onOpen,
}: {
  run: TaskRun;
  locale: string;
  href: string;
  onOpen: () => void;
}) {
  const { t } = useTranslation();
  const outcome = runOutcome(run);
  const duration = runDurationMs(run);

  return (
    <li className="record-run" data-outcome={outcome}>
      {/* One destination per row. A real href, so the run can be opened in a
          new tab or copied, with in-app navigation on a plain click. */}
      <a
        className="record-run-link"
        href={href}
        onClick={(event) => {
          if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.altKey || event.ctrlKey || event.shiftKey) return;
          event.preventDefault();
          onOpen();
        }}
      >
        <StateMark tone={TONE_FOR_OUTCOME[outcome]} shape={outcome === "pending" ? "dashed" : undefined} />
        <span className="record-run-date tnum">{runDate(run.scheduledFor ?? run.createdAt, locale)}</span>
        <span className="record-run-outcome">{t(`backlog.runs.outcome.${outcome}`)}</span>
        {/* A run that failed says why here; nothing else on the row can. */}
        {run.failureMessage ? <span className="record-run-reason">{run.failureMessage}</span> : null}
        <span className="record-run-meta tnum">
          {duration === null ? runTime(run.startedAt, locale) : formatRunDuration(duration)}
        </span>
        {run.artifactCount > 0 ? (
          <span className="record-run-files tnum">{t("backlog.runs.files", { count: run.artifactCount })}</span>
        ) : null}
      </a>
    </li>
  );
}
