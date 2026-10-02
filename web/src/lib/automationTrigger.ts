import type { RoutineTrigger, RoutineTriggerFilters, RoutineTriggerKind, RoutineTriggerOn } from "../types.js";

/* What starts an automation. Mirrors backend/relay/automations/trigger.py —
   keep the kinds, `on` values, and filter rules in step with it. */

export const TRIGGER_KINDS: readonly RoutineTriggerKind[] = ["schedule", "task_event", "run_event", "webhook", "manual"];
export const TRIGGER_ON: Readonly<Record<"task_event" | "run_event", readonly RoutineTriggerOn[]>> = {
  task_event: ["status_changed", "created"],
  run_event: ["failed", "completed"],
};
export const SCHEDULE_TRIGGER: RoutineTrigger = { kind: "schedule" };
export const TITLE_CONTAINS_MAX = 120;

export function isEventKind(kind: RoutineTriggerKind): kind is "task_event" | "run_event" {
  return kind === "task_event" || kind === "run_event";
}

export function triggerOf(task: { routineTrigger?: RoutineTrigger | null }): RoutineTrigger {
  const trigger = task.routineTrigger;
  return trigger && TRIGGER_KINDS.includes(trigger.kind) ? trigger : SCHEDULE_TRIGGER;
}

export function triggerForKind(kind: RoutineTriggerKind): RoutineTrigger {
  return isEventKind(kind) ? { kind, on: TRIGGER_ON[kind][0] } : { kind };
}

export function normalizeTriggerForSave(trigger: RoutineTrigger): RoutineTrigger {
  if (!isEventKind(trigger.kind)) return { kind: trigger.kind };
  const on = trigger.on && TRIGGER_ON[trigger.kind].includes(trigger.on) ? trigger.on : TRIGGER_ON[trigger.kind][0];
  const entries = Object.entries(trigger.filters ?? {})
    .map(([key, value]) => [key, typeof value === "string" ? value.trim() : value] as const)
    .filter(([key, value]) => Boolean(value) && (on === "status_changed" || (key !== "fromStatus" && key !== "toStatus")))
    .sort(([a], [b]) => a.localeCompare(b));
  const filters = Object.fromEntries(entries) as RoutineTriggerFilters;
  return entries.length ? { kind: trigger.kind, on, filters } : { kind: trigger.kind, on };
}

export function triggersEqual(a: RoutineTrigger, b: RoutineTrigger): boolean {
  return JSON.stringify(normalizeTriggerForSave(a)) === JSON.stringify(normalizeTriggerForSave(b));
}

/** The i18n key of the first problem the form must show, or null. */
export function triggerError(trigger: RoutineTrigger): string | null {
  const title = trigger.filters?.titleContains ?? "";
  return title.length > TITLE_CONTAINS_MAX ? "automation.errors.title_too_long" : null;
}
