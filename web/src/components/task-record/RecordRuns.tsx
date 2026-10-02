"use client";

import { useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { listTaskRuns } from "../../api";
import { RecordFailure } from "./RecordFailure";
import { RELAY_POLL_INTERVALS_MS } from "../../lib/relayPolling";
import { formatRunDuration, runDurationMs, runOutcome, type RunOutcome } from "../../lib/taskRuns";
import type { TaskRun } from "../../types";
import { ICON, RowOpen } from "../icons";
import { StateMark, type StateTone } from "../StateMark";
import { RecordWorkspace } from "./RecordWorkspace";

/**
 * A routine's runs, beside the folder of the one selected.
 *
 * A routine is a definition — it never runs itself, so its runs live in
 * promoted occurrences, and each one works in a folder of its own
 * (`tasks/<routine>/<run>/`). The ledger is the master list and the run's
 * folder is the detail: selecting a row re-roots the project's explorer at
 * that run, so a run's output sits next to its outcome instead of one tab
 * away under an opaque run id.
 *
 * The run is still a real task with its own events and threads, so each row
 * keeps a real link to that record — at the row's end, apart from the select
 * target, so choosing a run to look at never navigates away. Never an
 * accordion: the drawer used to unfold an event list inside a row inside a
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
  // A ledger that crosses New Year must not show two "Jan 3"s a year apart.
  const year = date.getFullYear() === new Date().getFullYear() ? undefined : "numeric";
  return new Intl.DateTimeFormat(locale || undefined, { month: "short", day: "numeric", year }).format(date);
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
  /* Null until the reader picks one: the newest run is what they came to
     see, and deriving it (rather than storing it) keeps it the newest as a
     fresh run lands. */
  const [pickedRunId, setPickedRunId] = useState<string | null>(null);

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
    return (
      <div className="record-runs-message">
        <RecordFailure message={t("backlog.runs.error")} onRetry={() => void runsQuery.refetch()} />
      </div>
    );
  }
  if (!runs) {
    return (
      <div className="record-runs-message">
        <p className="record-empty" role="status" aria-live="polite">{t("backlog.runs.loading")}</p>
      </div>
    );
  }
  if (runs.length === 0) {
    return (
      <div className="record-runs-message">
        <p className="record-empty">{t("backlog.runs.empty")}</p>
      </div>
    );
  }

  const selected = runs.find((run) => run.taskId === pickedRunId) ?? runs[0];
  const selectedDate = runDate(selected.scheduledFor ?? selected.createdAt, i18n.language);

  return (
    <div className="record-runs-split">
      <section className="record-runs-ledger" aria-label={t("record.tab_runs")}>
        {/* Column names, once. The rows are a table read down its columns —
            without a header a bare "2m" or "1 file" had to be decoded per row.
            Hidden from assistive tech: each row's button already reads as a
            sentence, and a header outside the list would be announced as
            orphaned text. */}
        <div className="record-run-head" aria-hidden="true">
          <span className="record-run-head-date">{t("backlog.runs.col_date")}</span>
          <span>{t("backlog.runs.col_outcome")}</span>
          <span className="record-run-head-num">{t("backlog.runs.col_duration")}</span>
          <span className="record-run-head-num">{t("backlog.runs.col_files")}</span>
        </div>
        <ol className="record-run-list">
          {runs.map((run) => (
            <RunRow
              key={run.taskId}
              run={run}
              locale={i18n.language}
              selected={run.taskId === selected.taskId}
              href={hrefForRun(run.taskId)}
              onSelect={() => setPickedRunId(run.taskId)}
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
      </section>
      {/* Keyed by run: a folder path or an open file belongs to the run it
          was browsed in, not to whichever run is selected next. */}
      <div className="record-runs-workspace">
        <RecordWorkspace key={selected.taskId} taskId={selected.taskId} rootLabel={selectedDate} />
      </div>
    </div>
  );
}

function RunRow({
  run,
  locale,
  selected,
  href,
  onSelect,
  onOpen,
}: {
  run: TaskRun;
  locale: string;
  selected: boolean;
  href: string;
  onSelect: () => void;
  onOpen: () => void;
}) {
  const { t } = useTranslation();
  const outcome = runOutcome(run);
  const duration = runDurationMs(run);
  /* The second line says the one thing the outcome word cannot: why a run
     failed, or since when one has been going. The trailing columns stay
     numbers only — a clock time in the duration column read as a duration. */
  const started = runTime(run.startedAt, locale);
  const detail = run.failureMessage
    ?? (outcome === "running" && started ? t("backlog.runs.started_at", { time: started }) : null);

  return (
    <li className="record-run" data-outcome={outcome}>
      {/* Selecting shows this run's folder beside the ledger. */}
      <button
        type="button"
        className="record-run-link"
        aria-pressed={selected}
        onClick={onSelect}
      >
        <StateMark tone={TONE_FOR_OUTCOME[outcome]} shape={outcome === "pending" ? "dashed" : undefined} />
        <span className="record-run-date tnum">
          {runDate(run.scheduledFor ?? run.createdAt, locale)}
          {run.triggerKind ? <span className="record-run-trigger">{t(`automation.ledger.${run.triggerKind}`)}</span> : null}
        </span>
        <span className="record-run-summary">
          <span className="record-run-outcome">{t(`backlog.runs.outcome.${outcome}`)}</span>
          {/* A failure's reason is clipped to one line; the title carries
              the whole of it, and the run's own record quotes it in full. */}
          {detail ? <span className="record-run-reason" title={detail}>{detail}</span> : null}
        </span>
        {/* Both numeric cells always render, empty or not, so the columns
            hold their line down the ledger. */}
        <span className="record-run-duration tnum">{duration === null ? "" : formatRunDuration(duration)}</span>
        <span className="record-run-files tnum">
          {run.artifactCount > 0 ? t("backlog.runs.files", { count: run.artifactCount }) : ""}
        </span>
      </button>
      {/* The run's own record. A real href, so it can be opened in a new tab
          or copied, with in-app navigation on a plain click. */}
      <a
        className="record-run-open"
        href={href}
        aria-label={t("record.open_run")}
        title={t("record.open_run")}
        onClick={(event) => {
          if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.altKey || event.ctrlKey || event.shiftKey) return;
          event.preventDefault();
          onOpen();
        }}
      >
        <RowOpen size={ICON.sm} aria-hidden="true" />
      </a>
    </li>
  );
}
