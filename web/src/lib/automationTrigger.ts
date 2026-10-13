import type { RoutineTrigger, RoutineTriggerFilters, RoutineTriggerKind, RoutineTriggerOn, TaskRun } from "../types.js";
import { defaultSchedule, presetOf, scheduleError } from "./automationSchedule.ts";

type Translate = (key: string, options?: Record<string, unknown>) => string;

/* What starts an automation. Mirrors backend/relay/automations/model.py —
   keep the kinds, `on` values, and filter rules in step with it. */

export const TRIGGER_KINDS: readonly RoutineTriggerKind[] = ["schedule", "task_event", "run_event", "webhook"];
export const MAX_TRIGGERS = 5;
export const TRIGGER_ON: Readonly<Record<"task_event" | "run_event", readonly RoutineTriggerOn[]>> = {
  task_event: ["status_changed", "created"],
  run_event: ["failed", "completed"],
};
export const TITLE_CONTAINS_MAX = 120;

export function isEventKind(kind: RoutineTriggerKind): kind is "task_event" | "run_event" {
  return kind === "task_event" || kind === "run_event";
}

export function triggersOf(task: { routineTriggers?: RoutineTrigger[] | null }): RoutineTrigger[] {
  return (task.routineTriggers ?? []).filter((trigger) => TRIGGER_KINDS.includes(trigger.kind));
}

export function triggerForKind(kind: RoutineTriggerKind): RoutineTrigger {
  if (kind === "schedule") return { kind, schedule: defaultSchedule() };
  if (isEventKind(kind)) return { kind, on: TRIGGER_ON[kind][0] };
  return { kind: "webhook" };
}

export function normalizeTriggerForSave(trigger: RoutineTrigger): RoutineTrigger {
  if (trigger.kind === "schedule") return trigger;
  if (trigger.kind === "webhook") return { kind: "webhook" };
  const on = trigger.on && TRIGGER_ON[trigger.kind].includes(trigger.on) ? trigger.on : TRIGGER_ON[trigger.kind][0];
  const entries = Object.entries(trigger.filters ?? {})
    .map(([key, value]) => [key, typeof value === "string" ? value.trim() : value] as const)
    .filter(([key, value]) => Boolean(value) && (on === "status_changed" || (key !== "fromStatus" && key !== "toStatus")))
    .sort(([a], [b]) => a.localeCompare(b));
  const filters = Object.fromEntries(entries) as RoutineTriggerFilters;
  return entries.length ? { kind: trigger.kind, on, filters } : { kind: trigger.kind, on };
}

export function triggersEqual(a: RoutineTrigger[], b: RoutineTrigger[]): boolean {
  return JSON.stringify(a.map(normalizeTriggerForSave)) === JSON.stringify(b.map(normalizeTriggerForSave));
}

/** The i18n key of the first problem the form must show, or null. */
export function triggerError(trigger: RoutineTrigger): string | null {
  if (trigger.kind === "schedule") return scheduleError(trigger.schedule);
  const title = "filters" in trigger ? trigger.filters?.titleContains ?? "" : "";
  return title.length > TITLE_CONTAINS_MAX ? "automation.errors.title_too_long" : null;
}

/* Ledger label keys under `automation.ledger`, by the event that fired a run
   and by the `on` an event trigger listens for. */
const FIRED_BY_KEYS: Readonly<Record<string, string>> = {
  "task.created": "task_created",
  "run.completed": "run_completed",
  "run.failed": "run_failed",
  webhook: "webhook",
  manual: "manual",
  schedule: "schedule",
};
const ON_KEYS: Readonly<Record<RoutineTriggerOn, string>> = {
  created: "task_created",
  status_changed: "status_any",
  completed: "run_completed",
  failed: "run_failed",
};

function statusLabel(status: string | undefined, t: Translate): string | null {
  return status ? t("automation.ledger.status_changed", { status: t(`backlog.statuses.${status}`) }) : null;
}

/** What fired one run, for the run ledger — or null for a run with no trigger stamp. */
export function runTriggerLabel(run: Pick<TaskRun, "triggerKind" | "triggerSummary">, t: Translate): string | null {
  if (!run.triggerKind) return null;
  const summary = run.triggerSummary;
  const label = (summary?.eventType === "task.status_changed" ? statusLabel(summary.toStatus, t) : null)
    ?? t(`automation.ledger.${FIRED_BY_KEYS[summary?.eventType ?? ""] ?? run.triggerKind}`);
  return summary && summary.eventCount > 1
    ? `${label} · ${t("automation.ledger.event_count", { count: summary.eventCount })}`
    : label;
}

/** One short phrase for one trigger. */
export function describeTrigger(trigger: RoutineTrigger, t: Translate): string {
  if (trigger.kind === "schedule") return t(`automation.presets.${presetOf(trigger.schedule.repeat)}`);
  if (trigger.kind === "webhook") return t("automation.kinds.webhook");
  const on = trigger.on ?? TRIGGER_ON[trigger.kind][0];
  return (on === "status_changed" ? statusLabel(trigger.filters?.toStatus, t) : null)
    ?? t(`automation.ledger.${ON_KEYS[on]}`);
}

/** One short phrase for what starts an automation: record band and list column. */
export function describeTriggers(triggers: RoutineTrigger[], t: Translate): string {
  if (triggers.length === 0) return t("automation.run_now_only");
  if (triggers.length > 1) return t("automation.trigger_count", { count: triggers.length });
  return describeTrigger(triggers[0], t);
}
