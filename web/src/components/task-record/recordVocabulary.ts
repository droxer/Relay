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

/* "workspace" is the live directory, browsed with the project's explorer;
   "artifacts" is the durable record of what runs produced. They shared one
   "files" tab, stacked, until the explorer needed the tab's full height.

   A routine has no Workspace tab: it never runs, and each of its runs owns a
   folder of its own, so its folders are browsed run by run in the Runs tab. */
export type RecordTab = "runs" | "activity" | "definition" | "workspace" | "artifacts";

export const TASK_RECORD_TABS: readonly RecordTab[] = ["activity", "definition", "workspace", "artifacts"];
export const ROUTINE_RECORD_TABS: readonly RecordTab[] = ["runs", "definition", "artifacts"];

/** Retired tab ids and where a link that still carries one should land. */
export const LEGACY_RECORD_TABS: Readonly<Record<RecordVariant, Readonly<Record<string, RecordTab>>>> = {
  task: { files: "workspace" },
  routine: { files: "runs", workspace: "runs" },
};

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
  const tab = (value && LEGACY_RECORD_TABS[variant][value]) || value;
  return tabs.includes(tab as RecordTab) ? (tab as RecordTab) : defaultRecordTab(variant);
}
