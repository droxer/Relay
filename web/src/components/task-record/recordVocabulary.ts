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

/* A task has no Workspace tab: a project task shares its project's
   directory, browsed on the project page, and an automation run's folder is
   browsed from its routine's Runs tab. Files is the durable record of what
   the task's runs produced, previewed in place.

   A routine has no Workspace tab either: it never runs, and each of its runs
   owns a folder of its own, browsed run by run in the Runs tab. */
export type RecordTab = "runs" | "activity" | "definition" | "artifacts";

export const TASK_RECORD_TABS: readonly RecordTab[] = ["activity", "definition", "artifacts"];
export const ROUTINE_RECORD_TABS: readonly RecordTab[] = ["runs", "definition", "artifacts"];

/** Retired tab ids and where a link that still carries one should land. */
export const LEGACY_RECORD_TABS: Readonly<Record<RecordVariant, Readonly<Record<string, RecordTab>>>> = {
  task: { files: "artifacts", workspace: "artifacts" },
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
