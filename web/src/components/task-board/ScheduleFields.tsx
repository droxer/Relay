"use client";

import { useId } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Field, FieldError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { previewSchedule } from "../../api";
import { useDebouncedValue } from "../../hooks/useDebouncedValue";
import {
  SCHEDULE_PRESETS, browserTimezone, presetOf, repeatForPreset, scheduleError, type SchedulePreset,
} from "../../lib/automationSchedule";
import type { RoutineSchedule, ScheduleRepeat } from "../../types";

/** The Select value standing for a null timezone — Select has no null item. */
const SERVER_TIME = "__server__";
const PREVIEW_DEBOUNCE_MS = 300;
const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const;

type Props = { schedule: RoutineSchedule; onChange: (next: RoutineSchedule) => void };

/** Which input a local schedule error belongs to. */
const ERROR_FIELD: Readonly<Record<string, string>> = {
  "automation.errors.time": "at",
  "automation.errors.days": "days",
  "automation.errors.month_day": "day",
  "automation.errors.minute": "minute",
  "automation.errors.once": "once",
  "automation.errors.cron": "cron",
};

export function ScheduleFields({ schedule, onChange }: Props) {
  const { t, i18n } = useTranslation();
  const presetLabelId = useId();
  const zoneLabelId = useId();
  const daysLabelId = useId();
  const errorId = useId();
  const repeat = schedule.repeat;
  const preset = presetOf(repeat);
  const setRepeat = (next: ScheduleRepeat) => onChange({ ...schedule, repeat: next });

  const localError = scheduleError(schedule);
  const settled = useDebouncedValue(schedule, PREVIEW_DEBOUNCE_MS);
  const settledValid = !scheduleError(settled);
  const preview = useQuery({
    queryKey: ["schedule-preview", JSON.stringify(settled)],
    queryFn: ({ signal }) => previewSchedule(settled, signal),
    enabled: settledValid,
    retry: false,
    staleTime: 60_000,
  });
  const serverError = !localError && settledValid && preview.error instanceof Error ? preview.error.message : null;
  const error = localError ? t(localError) : serverError;
  /* A server refusal names the schedule as a whole; it lands on the input
     that defines the preset (the cron line, the date, or the time). */
  const errorField = localError ? ERROR_FIELD[localError] : serverError ? primaryField(preset) : null;
  const invalid = (field: string) => (errorField === field
    ? { "aria-invalid": true as const, "aria-describedby": errorId }
    : {});

  const browserZone = browserTimezone();
  const zones = [...new Set([browserZone, "UTC", schedule.timezone].filter((zone): zone is string => Boolean(zone)))];
  const zoneLabel = (value: string) => (value === SERVER_TIME ? t("automation.timezone_server") : value);
  const next = preview.data?.next[0];
  const nextLabel = next
    ? new Intl.DateTimeFormat(i18n.language || undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(next))
    : null;

  return (
    <>
      <Field label={t("automation.repeat")} labelId={presetLabelId} wrapper="div">
        <Select value={preset} onValueChange={(value) => value && setRepeat(repeatForPreset(value as SchedulePreset, repeat))}>
          <SelectTrigger className="w-full" aria-labelledby={presetLabelId}>
            <SelectValue>{(value: SchedulePreset) => t(`automation.presets.${value}`)}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {SCHEDULE_PRESETS.map((option) => (
              <SelectItem key={option} value={option} label={t(`automation.presets.${option}`)}>{t(`automation.presets.${option}`)}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      {"at" in repeat ? (
        <Field label={t("automation.at")}>
          <Input type="time" name="automation-at" value={repeat.at} {...invalid("at")}
            onChange={(event) => setRepeat({ ...repeat, at: event.target.value })} />
        </Field>
      ) : null}
      {"minute" in repeat ? (
        <Field label={t("automation.minute")}>
          <Input type="number" name="automation-minute" min={0} max={59} value={numberValue(repeat.minute)}
            {...invalid("minute")} onChange={(event) => setRepeat({ ...repeat, minute: numberInput(event.target.value) })} />
        </Field>
      ) : null}
      {"day" in repeat ? (
        <Field label={t("automation.month_day")}>
          <Input type="number" name="automation-month-day" min={1} max={31} value={numberValue(repeat.day)}
            {...invalid("day")} onChange={(event) => setRepeat({ ...repeat, day: numberInput(event.target.value) })} />
        </Field>
      ) : null}
      {"once" in repeat ? (
        <Field label={t("automation.once_at")}>
          <Input type="datetime-local" name="automation-once" value={repeat.once} {...invalid("once")}
            onChange={(event) => setRepeat({ once: event.target.value })} />
        </Field>
      ) : null}
      {"cron" in repeat ? (
        <Field label={t("automation.cron")} hint={t("automation.cron_hint")} className="trigger-filters-wide">
          <Input name="automation-cron" className="font-mono" spellCheck={false} autoComplete="off" value={repeat.cron}
            {...invalid("cron")} onChange={(event) => setRepeat({ cron: event.target.value })} />
        </Field>
      ) : null}
      {"days" in repeat ? (
        <Field label={t("automation.days")} labelId={daysLabelId} wrapper="div" className="trigger-filters-wide">
          <div className="flex flex-wrap gap-1" role="group" aria-labelledby={daysLabelId} {...invalid("days")}>
            {WEEKDAYS.map((day) => {
              const pressed = repeat.days.includes(day);
              return (
                <Button key={day} type="button" size="xs" variant={pressed ? "secondary" : "outline"} aria-pressed={pressed}
                  onClick={() => setRepeat({
                    ...repeat,
                    days: pressed ? repeat.days.filter((item) => item !== day) : [...repeat.days, day].sort((a, b) => a - b),
                  })}>
                  {t(`automation.weekdays.${day}`)}
                </Button>
              );
            })}
          </div>
        </Field>
      ) : null}
      <Field label={t("automation.timezone")} labelId={zoneLabelId} wrapper="div">
        <Select value={schedule.timezone ?? SERVER_TIME}
          onValueChange={(value) => value && onChange({ ...schedule, timezone: value === SERVER_TIME ? null : value })}>
          <SelectTrigger className="w-full" aria-labelledby={zoneLabelId}>
            <SelectValue>{zoneLabel}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {[...zones, SERVER_TIME].map((zone) => (
              <SelectItem key={zone} value={zone} label={zoneLabel(zone)}>{zoneLabel(zone)}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <div className="trigger-filters-wide" aria-live="polite">
        {error ? <FieldError id={errorId}>{error}</FieldError> : preview.data ? (
          <p className="adm-form-hint">
            {nextLabel ? `${preview.data.summary} · ${t("automation.preview_next", { time: nextLabel })}` : preview.data.summary}
          </p>
        ) : null}
      </div>
    </>
  );
}

/* An emptied number input is NaN, not 0: 0 is a valid minute, so reading
   "" as 0 would save a schedule the reader never chose. */
function numberInput(raw: string): number {
  return raw.trim() === "" ? Number.NaN : Number(raw);
}

function numberValue(value: number): number | "" {
  return Number.isNaN(value) ? "" : value;
}

function primaryField(preset: SchedulePreset): string {
  if (preset === "cron" || preset === "once") return preset;
  return preset === "hour" ? "minute" : "at";
}
