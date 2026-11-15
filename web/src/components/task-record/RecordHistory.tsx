"use client";

import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { ArrowUpRight } from "lucide-react";
import { useTaskQueryRevision } from "../../hooks/useTaskQueryRevision";
import { listTaskEvents } from "../../api";
import { RELAY_POLL_INTERVALS_MS } from "../../lib/relayPolling";
import { RecordFailure } from "./RecordFailure";
import { pathForAppState } from "../../lib/appRoute";
import { historyDays, taskHistoryEntries, threadLinkEntryIds, type TaskHistoryEntry } from "../../lib/taskHistory";
import { TaskStatusIcon } from "../TaskStatusIcon";
import {
  historyActor,
  historyClock,
  historyDayLabel,
  historyEntryDetail,
  historyEntryLabel,
  type HistoryNameResolver,
} from "./taskHistoryLabel";
import type { RelayTaskEvent } from "../../types";

/**
 * Run history for one plain task.
 *
 * The task event log is the authoritative record of what a dispatch actually
 * did; without this the drawer showed a single "last activity" line and the
 * rest was reachable only through the API.
 *
 * It reads as days, newest first: the day is said once in a heading and each
 * line carries only its clock time. A status move wears the task's own status
 * glyph and the thread popover's wording ("Work resumed", "Accepted · by
 * you"); everything else is a quiet dot, so the moves are what the eye
 * follows. A move's reason — the agent's question, a blocker — sits under it
 * instead of being dropped.
 *
 * A routine does not come here — its runs happen in occurrences, and one flat
 * timeline across all of them says nothing about any single run. `RecordRuns`
 * is that surface.
 */
export function RecordHistory({
  taskId,
  live = false,
  revision,
  names,
  currentUserId,
  onOpenThread,
}: {
  taskId: string;
  revision?: string;
  /** The task is running — the timeline grows while the reader watches it. */
  live?: boolean;
  /** Team/agent names for assignment lines; without them an id still renders. */
  names?: HistoryNameResolver;
  /** Lets a move the reader made say "by you" rather than "by a teammate". */
  currentUserId?: string;
  onOpenThread?: (sessionId: string) => void;
}) {
  const { t, i18n } = useTranslation();

  /* Cached, and polled while the task is actually running. The timeline used
     to load once per mount and then sit frozen — on the surface whose job is
     watching a task, with a run ledger polling beside it on the routine's. */
  const eventsQuery = useQuery({
    queryKey: ["task-events", taskId],
    queryFn: ({ signal }) => listTaskEvents(taskId, {}, signal),
    // See RecordRuns: a tab switch must not refire this on every keystroke.
    staleTime: RELAY_POLL_INTERVALS_MS.tasks,
    refetchInterval: live ? RELAY_POLL_INTERVALS_MS.tasks : false,
  });
  useTaskQueryRevision("task-events", taskId, revision, eventsQuery.isFetching);
  const events: RelayTaskEvent[] | undefined = eventsQuery.data?.events;
  const entries = events ? taskHistoryEntries(events, taskId) : [];
  const threadLinkIds = threadLinkEntryIds(entries);

  return (
    <section className="record-timeline" aria-label={t("backlog.history_title")}>
      <h3 className="record-panel-title">
        {t("backlog.history_title")}
        {entries.length > 0 ? (
          <span className="record-panel-count tnum">{entries.length}</span>
        ) : null}
      </h3>
      {eventsQuery.isError ? (
        <RecordFailure message={t("backlog.history_error")} onRetry={() => void eventsQuery.refetch()} />
      ) : !events ? (
        <p className="record-panel-note" role="status" aria-live="polite">{t("backlog.history_loading")}</p>
      ) : entries.length === 0 ? (
        <p className="record-panel-note">{t(live ? "backlog.history_empty_live" : "backlog.history_empty")}</p>
      ) : (
        <div className="record-timeline-days">
          {historyDays(entries).map((day) => {
            const headingId = `record-history-${taskId}-${day.key}`;
            return (
              <section key={day.key} className="record-timeline-day" aria-labelledby={headingId}>
                <h4 id={headingId} className="record-timeline-day-label">
                  {historyDayLabel(day.timestamp, i18n.language, t)}
                </h4>
                <ol className="record-timeline-list">
                  {day.entries.map((entry) => (
                    <HistoryLine
                      key={entry.id}
                      entry={entry}
                      sessionId={threadLinkIds.has(entry.id) ? entry.sessionId : undefined}
                      names={names}
                      currentUserId={currentUserId}
                      onOpenThread={onOpenThread}
                    />
                  ))}
                </ol>
              </section>
            );
          })}
        </div>
      )}
    </section>
  );
}

function HistoryLine({ entry, sessionId, names, currentUserId, onOpenThread }: {
  entry: TaskHistoryEntry;
  /** Set on the one line that carries its thread's link. */
  sessionId?: string;
  names?: HistoryNameResolver;
  currentUserId?: string;
  onOpenThread?: (sessionId: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const status = entry.kind === "status" ? entry.status : undefined;
  const actor = status ? historyActor(entry, currentUserId) : "relay";
  const detail = historyEntryDetail(entry);

  return (
    <li className="record-timeline-entry" data-kind={status ? "status" : "event"} data-status={status}>
      <span className="record-timeline-marker" aria-hidden="true">
        {status ? <TaskStatusIcon status={status} className="record-timeline-icon" /> : <span className="record-timeline-dot" />}
      </span>
      <div className="record-timeline-body">
        <p className="record-timeline-head">
          <span className="record-timeline-label">{historyEntryLabel(entry, t, names, currentUserId)}</span>
          {actor === "relay" ? null : (
            <span className="record-timeline-actor">{t(`thread.lifecycle.by_${actor}`)}</span>
          )}
          <time className="record-timeline-time tnum" dateTime={entry.timestamp}>
            {historyClock(entry.timestamp, i18n.language)}
          </time>
        </p>
        {detail ? <p className="record-timeline-detail">{detail}</p> : null}
        {sessionId ? (
          <a
            className="record-inline-action record-timeline-thread"
            href={pathForAppState({ route: "main", mobileView: "chat", sessionId })}
            onClick={(event) => {
              if (!onOpenThread) return;
              if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.altKey || event.ctrlKey || event.shiftKey) return;
              event.preventDefault();
              onOpenThread(sessionId);
            }}
          >
            {t("backlog.open_thread")}
            <ArrowUpRight aria-hidden="true" />
          </a>
        ) : null}
      </div>
    </li>
  );
}
