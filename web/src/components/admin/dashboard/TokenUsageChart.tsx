"use client";

import { useTranslation } from "react-i18next";
import {
  Card,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { TokenUsageState } from "../../../hooks/useTokenUsage";
import { formatChartDate } from "../../../lib/chartDate";
import { formatCompact } from "../../../lib/compactNumber";
import { ChartLegend, StackedBarChart, type ChartColumn } from "./StackedBarChart";

const WIDTH = 720;
const HEIGHT = 200;
const PADDING = { top: 16, right: 16, bottom: 28, left: 36 };

const PLACEHOLDER_FULL = [
  0.32, 0.48, 0.41, 0.58, 0.66, 0.52, 0.71, 0.6, 0.78, 0.69, 0.84, 0.74, 0.91, 0.82,
];
const PLACEHOLDER_COMPACT = [0.36, 0.52, 0.45, 0.62, 0.74, 0.66, 0.88];

function PlaceholderBars({ compact }: { compact?: boolean }) {
  const heights = compact ? PLACEHOLDER_COMPACT : PLACEHOLDER_FULL;
  const innerW = WIDTH - PADDING.left - PADDING.right;
  const innerH = HEIGHT - PADDING.top - PADDING.bottom;
  const gap = compact ? 10 : 6;
  const barW = (innerW - gap * (heights.length - 1)) / heights.length;
  return (
    <svg
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      className="adm-dash-chart adm-dash-chart--empty"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      {heights.map((ratio, i) => {
        const h = ratio * innerH;
        const x = PADDING.left + i * (barW + gap);
        const y = PADDING.top + innerH - h;
        return (
          <rect
            key={i}
            x={x}
            y={y}
            width={barW}
            height={h}
            fill="var(--line-1)"
            opacity={0.55}
          />
        );
      })}
      <line
        x1={PADDING.left}
        x2={WIDTH - PADDING.right}
        y1={PADDING.top + innerH + 0.5}
        y2={PADDING.top + innerH + 0.5}
        stroke="var(--line-2)"
        strokeWidth={1}
      />
    </svg>
  );
}

interface TokenUsageChartProps {
  snapshot: TokenUsageState;
  compact?: boolean;
  className?: string;
}

export function TokenUsageChart({ snapshot, compact, className }: TokenUsageChartProps) {
  const { t, i18n } = useTranslation();
  const numberFormat = new Intl.NumberFormat(i18n.language || undefined);
  // Measured, not assumed: runtimes whose runs completed this week without
  // reporting counts (Kimi; Pi in its text fallback).
  const unreported = (snapshot.unreportedRuns ?? [])
    .map(({ agent, runs }) => t("admin.v2.dash_tokens_unreported_item", {
      agent: agent.charAt(0).toUpperCase() + agent.slice(1),
      count: runs,
    }))
    .join(", ");
  const coverageNote = unreported
    ? t("admin.v2.dash_tokens_unreported", { runs: unreported })
    : null;

  if (snapshot.isError) {
    return (
      <Card render={<section />} className={className}>
        <CardHeader><CardTitle render={<h2 />}>{t("admin.v2.dash_tokens_title")}</CardTitle></CardHeader>
        <CardDescription>{snapshot.error}</CardDescription>
      </Card>
    );
  }

  if (!snapshot.available || snapshot.daily.length === 0) {
    return (
      <Card render={<section />} className={className}>
        <CardHeader>
          <CardTitle render={<h2 />}>{t("admin.v2.dash_tokens_title")}</CardTitle>
        </CardHeader>
        <div className={`adm-dash-empty${compact ? " adm-dash-empty--compact" : ""}`}>
          <PlaceholderBars compact={compact} />
          <div className="adm-dash-empty-overlay">
            <p className="adm-dash-empty-copy">{t("admin.v2.dash_tokens_empty")}</p>
            {coverageNote ? <p className="adm-dash-empty-copy">{coverageNote}</p> : null}
          </div>
        </div>
      </Card>
    );
  }

  const points = compact ? snapshot.daily.slice(-7) : snapshot.daily;
  const visibleTotals = points.reduce(
    (totals, point) => ({
      input: totals.input + point.input,
      output: totals.output + point.output,
      cacheRead: totals.cacheRead + point.cacheRead,
      cacheWrite: totals.cacheWrite + point.cacheWrite,
    }),
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  );
  const format = (value: number) => formatCompact(value, i18n.language);
  const labels = {
    output: t("admin.v2.dash_tokens_output"),
    input: t("admin.v2.dash_tokens_input"),
    cache: t("admin.v2.dash_tokens_cache_write"),
  };
  // Bars plot fresh tokens only, stacked cache writes → input → output (the
  // product of the work on top). Cache reads would dwarf the rest — they are
  // most of a long run — so they are reported beside the chart, not in it.
  const series = [
    { key: "cache", label: labels.cache },
    { key: "input", label: labels.input },
    { key: "output", label: labels.output },
  ];
  const columns: ChartColumn[] = points.map((point) => ({
    key: point.date,
    label: formatChartDate(point.date, i18n.language),
    values: { cache: point.cacheWrite, input: point.input, output: point.output },
  }));

  return (
    <Card render={<section />} className={className}>
      <CardHeader className="adm-dash-chart-head">
        <CardTitle render={<h2 />}>{t("admin.v2.dash_tokens_title")}</CardTitle>
        <ChartLegend
          label={t("admin.v2.dash_tokens_legend")}
          items={[
            { key: "output", label: labels.output, total: format(visibleTotals.output) },
            { key: "input", label: labels.input, total: format(visibleTotals.input) },
            { key: "cache", label: labels.cache, total: format(visibleTotals.cacheWrite) },
          ]}
        />
      </CardHeader>
      <StackedBarChart
        className="adm-chart--short"
        columns={columns}
        series={series}
        format={format}
        barRatio={compact ? 0.42 : 0.6}
        labelEvery={compact ? 1 : 2}
        ariaLabel={t("admin.v2.dash_tokens_title")}
        totalLabel={(column, total) => t("admin.v2.dash_chart_tip_total", { date: column.label, total: format(total) })}
      />
      <ul className="sr-only">
        {points.map((point) => (
          <li key={point.date}>
            {`${point.date}: ${t("admin.v2.dash_tokens_input")} ${numberFormat.format(point.input)}, ${t("admin.v2.dash_tokens_output")} ${numberFormat.format(point.output)}, ${t("admin.v2.dash_tokens_cache_write")} ${numberFormat.format(point.cacheWrite)}, ${t("admin.v2.dash_tokens_cache_read")} ${numberFormat.format(point.cacheRead)}`}
          </li>
        ))}
      </ul>
      <CardFooter className="border-t adm-dash-chart-foot">
        <CardDescription render={<span />}>
          {t("admin.v2.dash_tokens_cache_read_note", { count: format(visibleTotals.cacheRead) })}
        </CardDescription>
        {coverageNote ? <CardDescription render={<span />}>{coverageNote}</CardDescription> : null}
      </CardFooter>
    </Card>
  );
}
