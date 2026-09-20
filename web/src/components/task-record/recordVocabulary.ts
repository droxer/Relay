import type { RelayTaskListItem } from "../../types.js";

/**
 * The one seam between the two vocabularies a task record speaks.
 *
 * A backlog task and a routine are the same record in different words: the
 * routine's history is a ledger of occurrences, the task's is its own
 * timeline; the routine is scheduled, the task is due. Everything that
 * differs is a value in this table.
 *
 * The rule the drawer broke and this must not: an `if (variant === "routine")`
 * inside a tab panel means the difference belongs here instead.
 */
export type RecordVariant = "task" | "routine";

export type RecordTab = "runs" | "activity" | "definition" | "files";

export const TASK_RECORD_TABS: readonly RecordTab[] = ["activity", "definition", "files"];
export const ROUTINE_RECORD_TABS: readonly RecordTab[] = ["runs", "definition", "files"];

export function recordVariant(task: Pick<RelayTaskListItem, "isRoutine">): RecordVariant {
  return task.isRoutine ? "routine" : "task";
}

export function recordTabs(variant: RecordVariant): readonly RecordTab[] {
  return variant === "routine" ? ROUTINE_RECORD_TABS : TASK_RECORD_TABS;
}

export function defaultRecordTab(variant: RecordVariant): RecordTab {
  return variant === "routine" ? "runs" : "activity";
}

export function parseRecordTab(value: string | null, variant: RecordVariant): RecordTab {
  const tabs = recordTabs(variant);
  return tabs.includes(value as RecordTab) ? (value as RecordTab) : defaultRecordTab(variant);
}
