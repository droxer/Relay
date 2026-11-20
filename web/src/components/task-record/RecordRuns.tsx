"use client";

import { useRef, useState, type KeyboardEvent } from "react";
import { keepPreviousData, useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { listTaskRuns } from "../../api";
import { RecordFailure } from "./RecordFailure";
import { runTriggerLabel } from "../../lib/automationTrigger";
import { RELAY_POLL_INTERVALS_MS } from "../../lib/relayPolling";
import { formatRunDuration, runDurationMs, runOutcome } from "../../lib/taskRuns";
import type { TaskRun, TaskRunsResponse } from "../../types";
import { StateMark } from "../StateMark";
import { RecordRunDetail, TONE_FOR_OUTCOME } from "./RecordRunDetail";
import { RecordWorkspace } from "./RecordWorkspace";
import { runDate, runTime } from "./runDates";

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
 * Above the folder, the selected run is said in full (`RecordRunDetail`):
 * outcome, start, duration, trigger, the whole failure reason, and real links
 * to its thread and its own record — so a row is one select target, choosing
 * a run to look at never navigates away, and ↑/↓ walk the ledger. Never an
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
const LEGACY_RUN_LIMIT = 200;

function precedes(run: TaskRun, tail: TaskRun): boolean {
  const when = run.scheduledFor ?? "";
  const tailWhen = tail.scheduledFor ?? "";
  if (when !== tailWhen) return when < tailWhen;
  if (run.createdAt !== tail.createdAt) return run.createdAt < tail.createdAt;
  return run.taskId < tail.taskId;
}

function isTerminal(run: TaskRun): boolean {
  const outcome = runOutcome(run);
  return outcome === "done" || outcome === "failed" || outcome === "cancelled";
}

/** ↑/↓ (and Home/End) walk the ledger the way a list box does: the next row
 *  takes focus and is selected, so its folder follows the keyboard. */
const STEP_FOR_KEY: Record<string, (index: number, count: number) => number> = {
  ArrowDown: (index, count) => Math.min(count - 1, index + 1),
  ArrowUp: (index) => Math.max(0, index - 1),
  Home: () => 0,
  End: (_index, count) => count - 1,
};

export function RecordRuns({
  taskId,
  hrefForRun,
  onOpenRun,
  onOpenThread,
}: {
  taskId: string;
  hrefForRun: (runTaskId: string) => string;
  onOpenRun: (runTaskId: string) => void;
  onOpenThread?: (sessionId: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const [limit, setLegacyLimit] = useState(RUN_PAGE_SIZE);
  /* Null until the reader picks one: the newest run is what they came to
     see, and deriving it (rather than storing it) keeps it the newest as a
     fresh run lands. */
  const [pickedRunId, setPickedRunId] = useState<string | null>(null);
  const listRef = useRef<HTMLOListElement>(null);

  const headKey = ["task-runs", taskId, limit] as const;
  const earlierKey = ["task-runs", taskId, "earlier"] as const;
  const runsQuery = useQuery({
    queryKey: headKey,
    queryFn: async ({ client, signal }) => {
      const page = await listTaskRuns(taskId, { limit }, signal);
      const earlier = client.getQueryState(earlierKey);
      if (!earlier?.data && earlier?.fetchStatus !== "fetching") return page;
      const previous = client.getQueryData<TaskRunsResponse>(headKey);
      const ids = new Set(page.runs.map(run => run.taskId));
      const tail = page.runs.at(-1);
      if (!tail || !page.nextCursor || !previous?.runs.some(run => ids.has(run.taskId))) {
        // The first page moved past the old window. Start any next read from
        // the new boundary so a burst of runs cannot leave a gap.
        if (!signal.aborted) void client.resetQueries({ queryKey: earlierKey, exact: true });
        return page;
      }
      // A new run can push rows off the head while someone reads an old page.
      // Keep that overlap without repeating the historical requests.
      return { ...page, runs: [...page.runs, ...previous.runs.filter(run => !ids.has(run.taskId) && precedes(run, tail))] };
    },
    placeholderData: keepPreviousData,
    // Tab panels unmount on switch and the tab strip activates on arrow keys,
    // so without a staleness horizon surfing the tabs refires every panel's
    // request per keystroke. One poll interval is how fresh the rest of the
    // record is anyway.
    staleTime: RELAY_POLL_INTERVALS_MS.tasks,
    // Settled ledgers still discover newly scheduled occurrences.
    refetchInterval: (query) =>
      query.state.data?.runs.some((run) => !isTerminal(run))
        ? RELAY_POLL_INTERVALS_MS.tasks : RELAY_POLL_INTERVALS_MS.runDiscovery,
  });
  const cursor = runsQuery.data?.nextCursor;
  const earlier = useInfiniteQuery({
    queryKey: earlierKey,
    initialPageParam: cursor ?? "",
    queryFn: ({ pageParam, signal }) => listTaskRuns(taskId, { limit: RUN_PAGE_SIZE, before: pageParam }, signal),
    getNextPageParam: (page) => page.nextCursor,
    enabled: false,
  });
  const byId = new Map(runsQuery.data?.runs.map(run => [run.taskId, run] as const));
  for (const page of earlier.data?.pages ?? []) {
    for (const run of page.runs) {
      if (!byId.has(run.taskId)) byId.set(run.taskId, run);
    }
  }
  const runs = runsQuery.data ? [...byId.values()] : undefined;
  const canLoadEarlier = earlier.data ? earlier.hasNextPage : Boolean(cursor);
  const legacyMore = cursor === undefined && (runs?.length ?? 0) >= limit && limit < LEGACY_RUN_LIMIT;

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
  const selectedIndex = runs.indexOf(selected);
  const selectedDate = runDate(selected.scheduledFor ?? selected.createdAt, i18n.language);

  function onListKeyDown(event: KeyboardEvent<HTMLOListElement>): void {
    const step = STEP_FOR_KEY[event.key];
    if (!step || !runs) return;
    event.preventDefault();
    const next = step(selectedIndex, runs.length);
    setPickedRunId(runs[next].taskId);
    listRef.current?.querySelectorAll<HTMLButtonElement>(".record-run-link")[next]?.focus();
  }

  return (
    <div className="record-runs-split">
      <section className="record-runs-ledger" aria-label={t("record.tab_runs")}>
        {/* Column names, once. Hidden from assistive tech: each row's button
            already reads as a sentence, and a header outside the list would
            be announced as orphaned text. */}
        <div className="record-run-head" aria-hidden="true">
          <span className="record-run-head-date">{t("backlog.runs.col_date")}</span>
          <span>{t("backlog.runs.col_outcome")}</span>
          <span className="record-run-head-num">{t("backlog.runs.col_duration")}</span>
        </div>
        <ol className="record-run-list" ref={listRef} onKeyDown={onListKeyDown}>
          {runs.map((run, index) => (
            <RunRow
              key={run.taskId}
              run={run}
              locale={i18n.language}
              selected={index === selectedIndex}
              onSelect={() => setPickedRunId(run.taskId)}
            />
          ))}
        </ol>
        {earlier.isError ? <RecordFailure message={t("backlog.runs.error")}
          onRetry={() => { void earlier.fetchNextPage({ cancelRefetch: false }); }} /> : null}
        {!earlier.isError && (canLoadEarlier || legacyMore) ? (
          <button
            type="button"
            className="record-run-more"
            disabled={runsQuery.isFetching || earlier.isFetching}
            onClick={() => {
              if (legacyMore) setLegacyLimit(current => Math.min(LEGACY_RUN_LIMIT, current + RUN_PAGE_SIZE));
              else void earlier.fetchNextPage({ cancelRefetch: false });
            }}
          >
            {t("record.runs_show_earlier")}
          </button>
        ) : null}
      </section>
      <div className="record-runs-workspace">
        <RecordRunDetail
          run={selected}
          runHref={hrefForRun(selected.taskId)}
          onOpenRun={() => onOpenRun(selected.taskId)}
          onOpenThread={onOpenThread}
        />
        {/* Keyed by run: a folder path or an open file belongs to the run it
            was browsed in, not to whichever run is selected next. */}
        <RecordWorkspace
          key={`${selected.taskId}:${selected.artifactsDir ?? ""}:${selected.latestSessionId ?? ""}`}
          taskId={selected.taskId}
          artifactsDir={selected.artifactsDir}
          threadId={selected.latestSessionId}
          rootLabel={selectedDate}
          scoped
        />
      </div>
    </div>
  );
}

/**
 * One run as the ledger reads it: when (day over clock time), what happened
 * (outcome over what fired it, or why it failed), and how long it took.
 * The whole row is one target — it selects the run, and the detail beside
 * the ledger carries the links into its thread and record.
 */
function RunRow({
  run,
  locale,
  selected,
  onSelect,
}: {
  run: TaskRun;
  locale: string;
  selected: boolean;
  onSelect: () => void;
}) {
  const { t } = useTranslation();
  const outcome = runOutcome(run);
  const duration = runDurationMs(run);
  /* The failure's reason when there is one — that is why people open the
     ledger — otherwise what fired the run. */
  const meta = run.failureMessage ?? runTriggerLabel(run, t);

  return (
    <li className="record-run" data-outcome={outcome}>
      <button
        type="button"
        className="record-run-link"
        aria-pressed={selected}
        /* One tab stop for the ledger: arrows move within it. */
        tabIndex={selected ? 0 : -1}
        onClick={onSelect}
      >
        <StateMark tone={TONE_FOR_OUTCOME[outcome]} shape={outcome === "pending" ? "dashed" : undefined} />
        <span className="record-run-when">
          <span className="record-run-date tnum">{runDate(run.scheduledFor ?? run.createdAt, locale)}</span>
          <span className="record-run-time tnum">{runTime(run.startedAt ?? run.createdAt, locale)}</span>
        </span>
        <span className="record-run-summary">
          <span className="record-run-outcome">{t(`backlog.runs.outcome.${outcome}`)}</span>
          {/* Clipped to two lines; the detail beside the ledger quotes it whole. */}
          {meta ? <span className="record-run-reason" title={meta}>{meta}</span> : null}
        </span>
        <span className="record-run-duration tnum">{duration === null ? "" : formatRunDuration(duration)}</span>
      </button>
    </li>
  );
}
