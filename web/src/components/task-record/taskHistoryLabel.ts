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
export function historyEntryLabel(entry: TaskHistoryEntry, t: TFunction): string {
  if (entry.kind === "activity") return entry.message ?? t("backlog.history.activity");
  if (entry.kind === "status") {
    return t("backlog.history.status", {
      status: entry.status ? t(`backlog.statuses.${entry.status}`) : "",
    });
  }
  const label = t(`backlog.history.${entry.kind}`);
  return entry.message ? `${label} — ${entry.message}` : label;
}

/** Clock time for a history line — the column reads vertically, so time only. */
export function historyTime(value: string, locale: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(locale || undefined, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}
