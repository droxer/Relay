"use client";

import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { listTaskEvents } from "../../api";
import { RELAY_POLL_INTERVALS_MS } from "../../lib/relayPolling";
import { RecordFailure } from "./RecordFailure";
import { pathForAppState } from "../../lib/appRoute";
import { taskHistoryEntries } from "../../lib/taskHistory";
import { historyEntryLabel, historyTime, type HistoryNameResolver } from "./taskHistoryLabel";
import type { RelayTaskEvent } from "../../types";

/**
 * Run history for one plain task.
 *
 * The task event log is the authoritative record of what a dispatch actually
 * did; without this the drawer showed a single "last activity" line and the
 * rest was reachable only through the API.
 *
 * A routine does not come here — its runs happen in occurrences, and one flat
 * timeline across all of them says nothing about any single run. `RecordRuns` is that
 * surface.
 */
export function RecordHistory({
  taskId,
  live = false,
  names,
  onOpenThread,
}: {
  taskId: string;
  /** The task is running — the timeline grows while the reader watches it. */
  live?: boolean;
  /** Team/agent names for assignment lines; without them an id still renders. */
  names?: HistoryNameResolver;
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
  const events: RelayTaskEvent[] | undefined = eventsQuery.data?.events;
  const entries = events ? taskHistoryEntries(events, taskId) : [];

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
        <p className="record-panel-note">{t("backlog.history_empty")}</p>
      ) : (
        <ol className="record-timeline-list">
          {entries.map((entry) => {
            const sessionId = entry.sessionId;
            return (
            <li key={entry.id} className="record-timeline-entry">
              <span className="record-timeline-time tnum">{historyTime(entry.timestamp, i18n.language)}</span>
              <span className="record-timeline-label">
                {historyEntryLabel(entry, t, names)}
              </span>
              {sessionId ? (
                <a
                  className="record-inline-action"
                  href={pathForAppState({ route: "backlog", mobileView: "chat", taskId, sessionId })}
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
            </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
