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
  const selectId = useId();
  const errorId = useId();
  const [draft, setDraft] = useState(() => range === "all" ? dashboardPresetRange("7d") : range);
  const valid = validDashboardRange(draft);
  const items = [
    { value: "7d", label: t("admin.v2.dash_range_7d") },
    { value: "30d", label: t("admin.v2.dash_range_30d") },
    { value: "month", label: t("admin.v2.dash_range_month") },
    { value: "all", label: t("admin.v2.dash_range_all") },
    { value: "custom", label: t("admin.v2.dash_range_custom") },
  ];
  const dateFormat = new Intl.DateTimeFormat(i18n.language || undefined, { month: "short", day: "numeric", year: "numeric" });
  const format = (date: string) => dateFormat.format(new Date(`${date}T12:00:00`));

  return (
    <form className="adm-dash-range" onSubmit={(event) => {
      event.preventDefault();
      if (preset === "custom" && valid) onApply(draft);
    }}>
      <div className="adm-dash-range-controls">
        <Field className="adm-dash-range-field adm-dash-range-preset" label={t("admin.v2.dash_range")} wrapper="div" htmlFor={selectId}>
          <Select items={items} value={preset} onValueChange={(next) => {
            if (!next) return;
            setDraft(range === "all" ? dashboardPresetRange("7d") : range);
            onPreset(next as DashboardRangeSelection);
          }}>
            <SelectTrigger id={selectId} className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent align="start" alignItemWithTrigger={false}>
              {items.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </Field>
        {preset === "custom" ? <>
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
          <Button className="adm-dash-range-apply" type="submit" variant="outline" disabled={!valid}>{t("admin.v2.dash_range_apply")}</Button>
        </> : null}
        <output className="adm-dash-range-summary tnum" aria-live="polite">
          {range === "all" ? t("admin.v2.dash_range_all") : `${format(range.start)} – ${format(range.end)}`}
        </output>
      </div>
      {preset === "custom" && !valid ? <FieldError id={errorId}>{t("admin.v2.dash_range_invalid")}</FieldError> : null}
      <p className="adm-dash-range-note">{t("admin.v2.dash_range_inventory_note")}</p>
    </form>
  );
}
