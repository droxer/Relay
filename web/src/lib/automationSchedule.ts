import type { RoutineSchedule, ScheduleRepeat } from "../types.js";

/* The schedule presets an automation can use. Mirrors
   backend/relay/automations/schedule.py — except the cron 15-minute floor,
   which only the backend evaluates; the preview endpoint reports it. */

export const SCHEDULE_PRESETS = ["hour", "day", "weekday", "week", "month", "once", "cron"] as const;
export type SchedulePreset = (typeof SCHEDULE_PRESETS)[number];
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
const ONCE = /^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d$/;
const DEFAULT_AT = "09:00";

export function presetOf(repeat: ScheduleRepeat): SchedulePreset {
  if ("cron" in repeat) return "cron";
  if ("once" in repeat) return "once";
  return repeat.every;
}

export function repeatForPreset(preset: SchedulePreset, previous?: ScheduleRepeat, today = new Date()): ScheduleRepeat {
  const at = previous && "at" in previous ? previous.at : DEFAULT_AT;
  switch (preset) {
    case "hour": return { every: "hour", minute: 0 };
    case "day": return { every: "day", at };
    case "weekday": return { every: "weekday", at };
    case "week": return { every: "week", at, days: [1] };
    case "month": return { every: "month", at, day: 1 };
    case "once": return { once: `${today.toISOString().slice(0, 10)}T${at}` };
    case "cron": return { cron: "0 9 * * 1-5" };
  }
}

export function browserTimezone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

export function defaultSchedule(): RoutineSchedule {
  return { timezone: browserTimezone(), repeat: { every: "weekday", at: DEFAULT_AT } };
}

/** The i18n key of the first problem the form must show, or null. */
export function scheduleError(schedule: RoutineSchedule): string | null {
  const repeat = schedule.repeat;
  if ("at" in repeat && !TIME.test(repeat.at)) return "automation.errors.time";
  if ("days" in repeat && repeat.days.length === 0) return "automation.errors.days";
  if ("day" in repeat && !inRange(repeat.day, 1, 31)) return "automation.errors.month_day";
  if ("minute" in repeat && !inRange(repeat.minute, 0, 59)) return "automation.errors.minute";
  if ("once" in repeat && !ONCE.test(repeat.once)) return "automation.errors.once";
  if ("cron" in repeat && repeat.cron.trim().split(/\s+/).length !== 5) return "automation.errors.cron";
  return null;
}

/* An emptied number field reads as NaN, which no range comparison catches. */
function inRange(value: number, min: number, max: number): boolean {
  return Number.isInteger(value) && value >= min && value <= max;
}
