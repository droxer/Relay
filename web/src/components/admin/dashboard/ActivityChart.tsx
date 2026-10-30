"use client";

import { useTranslation } from "react-i18next";
import {
  Card,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { cn } from "@/lib/utils";
import {
  activityChartMetrics,
  activityOutcomes,
  activityTotals,
  type ActivityChartPoint,
} from "@/lib/activityChart";
import { formatChartDate } from "@/lib/chartDate";
import { formatCompact } from "@/lib/compactNumber";
import { ChartLegend, StackedBarChart, type ChartColumn } from "./StackedBarChart";

interface ActivityChartProps {
  daily: ActivityChartPoint[];
  ready: boolean;
  error?: string | null;
  className?: string;
}

const PLACEHOLDER_DAYS = 14;

export function ActivityChart({ daily, ready, error, className }: ActivityChartProps) {
  const { t, i18n } = useTranslation();
  const points = daily ?? [];
  const hasData = points.length > 0;
  const { dataPeak } = activityChartMetrics(points);
  const outcomes = activityOutcomes(points);
  const totals = activityTotals(points);
  const format = (value: number) => formatCompact(value, i18n.language);

  // Outcome is the story: completed takes the series colour, failed --err,
  // and stopped or still-open threads sit underneath in a quiet grey.
  const labels = {
    completed: t("admin.v2.dash_sessions_completed"),
    failed: t("admin.v2.dash_sessions_failed"),
    other: t("admin.v2.dash_sessions_other"),
  };
  const series = [
    { key: "other", label: labels.other },
    { key: "failed", label: labels.failed },
    { key: "completed", label: labels.completed },
  ];
  const columns: ChartColumn[] = hasData
    ? outcomes.map((day) => ({
        key: day.date,
        label: formatChartDate(day.date, i18n.language),
        values: { completed: day.completed, failed: day.failed, other: day.other },
      }))
    : Array.from({ length: PLACEHOLDER_DAYS }, (_, index) => ({ key: `d${index}`, label: "", values: {} }));

  return (
    <Card render={<section />} className={cn("adm-dash-card--chart", className)}>
      <CardHeader className="adm-dash-chart-head">
        <CardTitle render={<h2 />}>{t("admin.v2.dash_sessions_title")}</CardTitle>
        {hasData ? (
          <ChartLegend
            label={t("admin.v2.dash_sessions_legend")}
            items={[
              { key: "completed", label: labels.completed, total: format(totals.completed) },
              { key: "failed", label: labels.failed, total: format(totals.failed) },
              { key: "other", label: labels.other, total: format(totals.other) },
            ]}
          />
        ) : null}
      </CardHeader>
      <StackedBarChart
        columns={columns}
        series={series}
        format={format}
        floor={4}
        barRatio={0.58}
        labelEvery={2}
        ariaLabel={t("admin.v2.dash_sessions_title")}
        totalLabel={(column, total) => t("admin.v2.dash_chart_tip_total", { date: column.label, total: format(total) })}
      />
      {hasData ? (
        <ul className="sr-only">
          {outcomes.map((day) => (
            <li key={day.date}>
              {`${formatChartDate(day.date, i18n.language)}: ${day.total} · ${labels.completed} ${day.completed}, ${labels.failed} ${day.failed}, ${labels.other} ${day.other}`}
            </li>
          ))}
        </ul>
      ) : null}
      <CardFooter className="border-t">
        <CardDescription render={<span />}>
          {error
            ? error
            : ready
            ? dataPeak > 0
              ? t("admin.v2.dash_sessions_hint", { count: dataPeak })
              : t("admin.v2.dash_sessions_empty")
            : t("admin.v2.dash_loading")}
        </CardDescription>
      </CardFooter>
    </Card>
  );
}
