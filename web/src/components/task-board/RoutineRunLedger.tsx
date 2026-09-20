"use client";

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { listTaskEvents, listTaskRuns } from "../../api";
import { hrefForRoute } from "../../lib/appRoute";
import { formatRunDuration, runDurationMs, runOutcome, type RunOutcome } from "../../lib/taskRuns";
import { taskHistoryEntries } from "../../lib/taskHistory";
import { historyEntryLabel, historyTime } from "./taskHistoryLabel";
import type { RelayTaskEvent, TaskRun } from "../../types";
import { StateMark, type StateTone } from "../StateMark";
import { Button } from "@/components/ui/button";

/**
 * The run ledger for one task or routine.
 *
 * A routine is a definition — it never runs itself, so its runs live in
 * promoted occurrences that otherwise scatter into the backlog lanes with no
 * visible tie to the routine that caused them. Flattening every occurrence's
 * events into one timeline (what the drawer did before) answered "what
 * happened" and never "is this routine healthy": thirty runs of bookkeeping
 * read as one undifferentiated list.
 *
 * Here one row is one run, dated by the day it was scheduled for, and the
 * per-run event detail nests under the row that caused it.
 */
export function RoutineRunLedger({
  taskId,
  onOpenThread,
}: {
  taskId: string;
  onOpenThread?: (sessionId: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const [runs, setRuns] = useState<TaskRun[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setRuns(null);
    setFailed(false);
    setExpanded(null);
    listTaskRuns(taskId, {}, controller.signal)
      // `?? []` because `runs.length` is read unconditionally below: a
      // response missing the key would otherwise take down the whole pane
      // that mounts this, which is not what a bad payload deserves.
      .then((response) => setRuns(response.runs ?? []))
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      });
    return () => controller.abort();
  }, [taskId]);

  return (
    <section className="task-drawer-runs" aria-label={t("backlog.runs.title")}>
      <h3 className="task-drawer-artifacts-title">
        {t("backlog.runs.title")}
        {runs && runs.length > 0 ? (
          <span className="task-drawer-artifacts-count tnum">{runs.length}</span>
        ) : null}
      </h3>
      {failed ? (
        <p className="task-drawer-artifacts-empty" role="alert">{t("backlog.runs.error")}</p>
      ) : runs === null ? (
        <p className="task-drawer-artifacts-empty" role="status" aria-live="polite">{t("backlog.runs.loading")}</p>
      ) : runs.length === 0 ? (
        <p className="task-drawer-artifacts-empty">{t("backlog.runs.empty")}</p>
      ) : (
        <ol className="task-drawer-run-list">
          {runs.map((run) => (
            <RunRow
              key={run.taskId}
              run={run}
              locale={i18n.language}
              expanded={expanded === run.taskId}
              onToggle={() => setExpanded((current) => (current === run.taskId ? null : run.taskId))}
              onOpenThread={onOpenThread}
            />
          ))}
        </ol>
      )}
    </section>
  );
}

/** Outcome → the tone half of the state vocabulary; `StateMark` picks the shape. */
const TONE_FOR_OUTCOME: Record<RunOutcome, StateTone> = {
  done: "good",
  failed: "bad",
  running: "live",
  pending: "neutral",
};

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

function RunRow({
  run,
  locale,
  expanded,
  onToggle,
  onOpenThread,
}: {
  run: TaskRun;
  locale: string;
  expanded: boolean;
  onToggle: () => void;
  onOpenThread?: (sessionId: string) => void;
}) {
  const { t } = useTranslation();
  const outcome = runOutcome(run);
  const duration = runDurationMs(run);
  const sessionId = run.latestSessionId;

  return (
    <li className="task-drawer-run" data-outcome={outcome} data-expanded={expanded ? "true" : undefined}>
      <div className="task-drawer-run-head">
        <Button
          variant="ghost"
          type="button"
          className="task-drawer-run-main"
          aria-expanded={expanded}
          onClick={onToggle}
        >
          <StateMark tone={TONE_FOR_OUTCOME[outcome]} shape={outcome === "pending" ? "dashed" : undefined} />
          <span className="task-drawer-run-date tnum">
            {runDate(run.scheduledFor ?? run.createdAt, locale)}
          </span>
          <span className="task-drawer-run-outcome">{t(`backlog.runs.outcome.${outcome}`)}</span>
          {/* A run that failed says why here; nothing else on the row can. */}
          {run.failureMessage ? (
            <span className="task-drawer-run-reason">{run.failureMessage}</span>
          ) : null}
          <span className="task-drawer-run-meta tnum">
            {duration === null ? runTime(run.startedAt, locale) : formatRunDuration(duration)}
          </span>
          {run.artifactCount > 0 ? (
            <span className="task-drawer-run-files tnum">
              {t("backlog.runs.files", { count: run.artifactCount })}
            </span>
          ) : null}
        </Button>
        {sessionId ? (
          <a
            className="task-drawer-artifact-download"
            href={hrefForRoute("main", sessionId)}
            onClick={(event) => {
              if (!onOpenThread) return;
              if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.altKey || event.ctrlKey || event.shiftKey) return;
              event.preventDefault();
              onOpenThread(sessionId);
            }}
          >
            {t("backlog.open_thread")}
          </a>
        ) : null}
      </div>
      {expanded ? <RunEvents taskId={run.taskId} locale={locale} /> : null}
    </li>
  );
}

/**
 * One run's event log, fetched only when its row is open.
 *
 * Scoped to the occurrence rather than filtered out of the routine's merged
 * log: the merged fetch grows with the routine's whole history, and a row that
 * is open needs exactly one run's events.
 */
function RunEvents({ taskId, locale }: { taskId: string; locale: string }) {
  const { t } = useTranslation();
  const [events, setEvents] = useState<RelayTaskEvent[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setEvents(null);
    setFailed(false);
    listTaskEvents(taskId, {}, controller.signal)
      .then((response) => setEvents(response.events))
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      });
    return () => controller.abort();
  }, [taskId]);

  if (failed) {
    return <p className="task-drawer-artifacts-empty" role="alert">{t("backlog.history_error")}</p>;
  }
  if (events === null) {
    return (
      <p className="task-drawer-artifacts-empty" role="status" aria-live="polite">
        {t("backlog.history_loading")}
      </p>
    );
  }

  const entries = taskHistoryEntries(events, taskId);
  if (entries.length === 0) {
    return <p className="task-drawer-artifacts-empty">{t("backlog.history_empty")}</p>;
  }

  return (
    <ol className="task-drawer-run-events">
      {entries.map((entry) => (
        <li key={entry.id} className="task-drawer-history-entry">
          <span className="task-drawer-history-time tnum">{historyTime(entry.timestamp, locale)}</span>
          <span className="task-drawer-history-label">{historyEntryLabel(entry, t)}</span>
        </li>
      ))}
    </ol>
  );
}
