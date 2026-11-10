"use client";

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { validDashboardRange, type DashboardDateRange, type DashboardPreset } from "@/lib/dashboardRange";

export function DashboardRangePicker({ preset, range, onPreset, onApply }: {
  preset: DashboardPreset | "custom";
  range: DashboardDateRange;
  onPreset: (preset: DashboardPreset | "custom") => void;
  onApply: (range: DashboardDateRange) => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(range);
  const valid = validDashboardRange(draft);
  return (
    <form className="adm-dash-range" onSubmit={(event) => {
      event.preventDefault();
      if (valid) onApply(draft);
    }}>
      <label className="adm-dash-range-field">
        <span>{t("admin.v2.dash_range")}</span>
        <select className="adm-dash-range-select" value={preset} onChange={(event) => {
          const next = event.target.value as DashboardPreset | "custom";
          setDraft(range);
          onPreset(next);
        }}>
          <option value="7d">{t("admin.v2.dash_range_7d")}</option>
          <option value="30d">{t("admin.v2.dash_range_30d")}</option>
          <option value="month">{t("admin.v2.dash_range_month")}</option>
          <option value="custom">{t("admin.v2.dash_range_custom")}</option>
        </select>
      </label>
      {preset === "custom" ? <>
        <label className="adm-dash-range-field">
          <span>{t("admin.v2.dash_range_start")}</span>
          <Input type="date" required value={draft.start} max={draft.end || undefined}
            onChange={(event) => setDraft({ ...draft, start: event.target.value })} />
        </label>
        <label className="adm-dash-range-field">
          <span>{t("admin.v2.dash_range_end")}</span>
          <Input type="date" required value={draft.end} min={draft.start || undefined}
            onChange={(event) => setDraft({ ...draft, end: event.target.value })} />
        </label>
        <Button type="submit" variant="outline" disabled={!valid}>{t("admin.v2.dash_range_apply")}</Button>
        {!valid ? <span className="adm-dash-range-note" role="status">{t("admin.v2.dash_range_invalid")}</span> : null}
      </> : null}
      <span className="adm-dash-range-note">{t("admin.v2.dash_range_inventory_note")}</span>
    </form>
  );
}
