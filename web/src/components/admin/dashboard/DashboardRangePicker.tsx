"use client";

import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Field, FieldError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { dashboardPresetRange, validDashboardRange, type DashboardDateRange, type DashboardRange, type DashboardRangeSelection } from "@/lib/dashboardRange";

export function DashboardRangePicker({ preset, range, onPreset, onApply }: {
  preset: DashboardRangeSelection;
  range: DashboardRange;
  onPreset: (preset: DashboardRangeSelection) => void;
  onApply: (range: DashboardDateRange) => void;
}) {
  const { t, i18n } = useTranslation();
  const helpId = useId();
  const errorId = useId();
  const [draft, setDraft] = useState(() => range === "all" ? dashboardPresetRange("7d") : range);
  const valid = validDashboardRange(draft);
  const items = [
    { value: "today", label: t("admin.v2.dash_range_today") },
    { value: "7d", label: t("admin.v2.dash_range_7d") },
    { value: "30d", label: t("admin.v2.dash_range_30d") },
    { value: "month", label: t("admin.v2.dash_range_month") },
    { value: "all", label: t("admin.v2.dash_range_all") },
    { value: "custom", label: t("admin.v2.dash_range_custom") },
  ];
  const dateFormat = new Intl.DateTimeFormat(i18n.language || undefined, { month: "short", day: "numeric", year: "numeric" });
  const summary = range === "all" ? t("admin.v2.dash_range_all") : dateFormat.formatRange(
    new Date(`${range.start}T12:00:00`), new Date(`${range.end}T12:00:00`),
  );

  return (
    <form className="adm-dash-range" onSubmit={(event) => {
      event.preventDefault();
      if (preset === "custom" && valid) onApply(draft);
    }}>
      <div className="adm-dash-range-controls">
        <Select items={items} value={preset} onValueChange={(next) => {
          if (!next) return;
          setDraft(range === "all" ? dashboardPresetRange("7d") : range);
          onPreset(next as DashboardRangeSelection);
        }}>
          <SelectTrigger size="sm" aria-label={t("admin.v2.dash_range")} aria-describedby={helpId}
            className="w-auto border-transparent bg-transparent px-2 font-normal text-body hover:border-transparent hover:bg-(--control-fill-hover) aria-expanded:bg-(--control-fill-hover)">
            <SelectValue />
          </SelectTrigger>
          <SelectContent align="start" alignItemWithTrigger={false} className="min-w-44">
            {items.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}
          </SelectContent>
        </Select>
        <output className={range === "all" ? "sr-only" : "adm-dash-range-summary tnum"} aria-live="polite">
          {summary}
        </output>
      </div>
      {preset === "custom" ? <div className="adm-dash-range-custom">
        <Field className="adm-dash-range-field" label={t("admin.v2.dash_range_start")}>
          <Input type="date" required value={draft.start} max={draft.end || undefined}
            aria-invalid={!valid || undefined} aria-describedby={!valid ? errorId : undefined}
            onChange={(event) => setDraft({ ...draft, start: event.target.value })} />
        </Field>
        <Field className="adm-dash-range-field" label={t("admin.v2.dash_range_end")}>
          <Input type="date" required value={draft.end} min={draft.start || undefined}
            aria-invalid={!valid || undefined} aria-describedby={!valid ? errorId : undefined}
            onChange={(event) => setDraft({ ...draft, end: event.target.value })} />
        </Field>
        <Button className="adm-dash-range-apply" type="submit" variant="ghost" size="sm" disabled={!valid}>{t("admin.v2.dash_range_apply")}</Button>
      </div> : null}
      {preset === "custom" && !valid ? <FieldError id={errorId}>{t("admin.v2.dash_range_invalid")}</FieldError> : null}
      <p id={helpId} className="sr-only">{t("admin.v2.dash_range_inventory_note")}</p>
    </form>
  );
}
