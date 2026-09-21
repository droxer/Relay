import type { TFunction } from "i18next";
import type { TaskHistoryEntry } from "../../lib/taskHistory";

/**
 * The wording for one history line.
 *
 * `taskHistoryEntries` stays pure so it can be tested without i18n, which
 * leaves the phrasing to the components — and two of them now render these
 * lines (the plain task's timeline and one run's nested detail). Keeping the
 * wording here is what stops those two from drifting apart.
 */
/** Names the timeline can print for an assignment target. Both lookups are
    optional: an unresolved id still renders, just without a name. */
export type HistoryNameResolver = {
  teamName?: (teamId: string) => string | undefined;
  agentName?: (agentId: string) => string | undefined;
};

export function historyEntryLabel(entry: TaskHistoryEntry, t: TFunction, names?: HistoryNameResolver): string {
  if (entry.kind === "activity") return entry.message ?? t("backlog.history.activity");
  if (entry.kind === "status") {
    return t("backlog.history.status", {
      status: entry.status ? t(`backlog.statuses.${entry.status}`) : "",
    });
  }
  if (entry.kind === "assigned") {
    const name = entry.teamId
      ? names?.teamName?.(entry.teamId)
      : entry.agentId
        ? names?.agentName?.(entry.agentId)
        : entry.agent;
    return name ? t("backlog.history.assigned_to", { name }) : t("backlog.history.assigned");
  }
  const label = t(`backlog.history.${entry.kind}`);
  return entry.message ? `${label} — ${entry.message}` : label;
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
