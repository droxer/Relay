import type { TFunction } from "i18next";
import type { TaskHistoryEntry } from "../../lib/taskHistory";
import type { LifecycleActor, LifecycleMarker } from "../../lib/taskThreadLifecycle";

/**
 * The wording for task history — the record's run history and the thread's
 * task-status popover.
 *
 * `taskHistoryEntries` and `threadLifecycleMarkers` stay pure so they can be
 * tested without i18n, which leaves the phrasing here. Both surfaces say a
 * status move the same way ("Work resumed", "Accepted · by you"); the record
 * used to print "Status: Running" for every start, resume, and reopen alike.
 */

/** Names the timeline can print for an assignment target. Both lookups are
    optional: an unresolved id still renders, just without a name. */
export type HistoryNameResolver = {
  teamName?: (teamId: string) => string | undefined;
  agentName?: (agentId: string) => string | undefined;
  projectName?: (projectId: string) => string | undefined;
};

/** The move in words. The same target reads differently by where it came
 *  from: running again after a question is resuming, after review is a
 *  reopen; done straight out of review by a person is their acceptance. */
export function lifecycleLabel(marker: Pick<LifecycleMarker, "from" | "to" | "actor">, t: TFunction): string {
  const { from, to } = marker;
  if (from === "blocked" && to !== "blocked" && to !== "done") {
    return `${t("thread.lifecycle.unblocked")} · ${t(`backlog.statuses.${to}`)}`;
  }
  if (to === "running" && from === "waiting_for_human") return t("thread.lifecycle.resumed");
  if (to === "running" && (from === "review" || from === "done")) return t("thread.lifecycle.reopened");
  if (to === "done" && from === "review" && marker.actor !== "relay") return t("thread.lifecycle.accepted");
  return t(`thread.lifecycle.to_${to}`);
}

/** Who made a move: the reader, another person, or Relay itself. */
export function historyActor(entry: TaskHistoryEntry, currentUserId?: string): LifecycleActor {
  if (!entry.actorUserId) return "relay";
  return entry.actorUserId === currentUserId ? "you" : "teammate";
}

/** The line's headline. Its reason or message, if any, is `historyEntryDetail`. */
export function historyEntryLabel(
  entry: TaskHistoryEntry,
  t: TFunction,
  names?: HistoryNameResolver,
  currentUserId?: string,
): string {
  if (entry.kind === "activity") return entry.message ?? t("backlog.history.activity");
  if (entry.kind === "status" && entry.status) {
    return lifecycleLabel({ from: entry.from ?? "backlog", to: entry.status, actor: historyActor(entry, currentUserId) }, t);
  }
  if (entry.kind === "assigned") {
    const name = entry.teamId
      ? names?.teamName?.(entry.teamId)
      : entry.agentId
        ? names?.agentName?.(entry.agentId)
        : entry.agent;
    return name ? t("backlog.history.assigned_to", { name }) : t("backlog.history.assigned");
  }
  if (entry.kind === "project_set") {
    const name = entry.projectId ? names?.projectName?.(entry.projectId) : undefined;
    return name ? t("backlog.history.project_set_to", { name }) : t("backlog.history.project_set");
  }
  return t(`backlog.history.${entry.kind}`);
}

/** Why the line happened — a parked question, a blocker, a dispatch refusal.
    An activity line's message is its headline, so it has none. */
export function historyEntryDetail(entry: TaskHistoryEntry): string | undefined {
  if (entry.kind === "activity") return undefined;
  return entry.message?.trim() || undefined;
}

/** Clock time for a history line. Entries from another day carry their date —
    a run history that only ever says "12:01 AM" forces the reader to guess
    which day a line belongs to. */
export function historyTime(value: string, locale: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const now = new Date();
  const sameDay = date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth()
    && date.getDate() === now.getDate();
  return new Intl.DateTimeFormat(locale || undefined, sameDay
    ? { hour: "2-digit", minute: "2-digit" }
    : { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(date);
}

/** Clock time alone, for a line under a day heading that already says the date. */
export function historyClock(value: string, locale: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(locale || undefined, { hour: "2-digit", minute: "2-digit" }).format(date);
}

const DAY_MS = 86_400_000;

/** A day group's heading: Today, Yesterday, else the weekday and date — with
    the year only when it is not this one. */
export function historyDayLabel(value: string, locale: string, t: TFunction, now = new Date()): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const startOf = (day: Date) => new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime();
  const days = Math.round((startOf(now) - startOf(date)) / DAY_MS);
  if (days === 0) return t("backlog.history.today");
  if (days === 1) return t("backlog.history.yesterday");
  return new Intl.DateTimeFormat(locale || undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  }).format(date);
}
