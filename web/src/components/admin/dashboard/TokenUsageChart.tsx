"use client";

import { useTranslation } from "react-i18next";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { TokenUsageState } from "../../../hooks/useTokenUsage";
import { formatChartDate } from "../../../lib/chartDate";
import { formatCompact } from "../../../lib/compactNumber";

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
  // Bars plot fresh tokens only. Cache reads would dwarf the rest (they are
  // most of a long run) and flatten output, the product of the work, to a
  // sliver; the summary line above still reports them.
  const maxFresh = Math.max(1, ...points.map((point) => point.fresh));
  const innerW = WIDTH - PADDING.left - PADDING.right;
  const innerH = HEIGHT - PADDING.top - PADDING.bottom;
  // Wider gutters than the placeholder: airy bars keep this card supporting
  // evidence rather than the heaviest mass on the dashboard.
  const gap = compact ? 22 : 12;
  const barW = Math.max(4, (innerW - gap * Math.max(0, points.length - 1)) / Math.max(1, points.length));

  return (
    <Card render={<section />} className={className}>
      <CardHeader>
        <CardTitle render={<h2 />}>{t("admin.v2.dash_tokens_title")}</CardTitle>
      </CardHeader>
      <CardDescription>
        {t("admin.v2.dash_tokens_summary", {
          // Same voice as the KPI tile above it (36.9M), not 16,280,000.
          input: formatCompact(visibleTotals.input, i18n.language),
          output: formatCompact(visibleTotals.output, i18n.language),
          cacheWrite: formatCompact(visibleTotals.cacheWrite, i18n.language),
          cacheRead: formatCompact(visibleTotals.cacheRead, i18n.language),
        })}
      </CardDescription>
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="adm-dash-chart adm-dash-token-chart"
        preserveAspectRatio="none"
        role="img"
        aria-label={t("admin.v2.dash_tokens_title")}
      >
        <line
          x1={PADDING.left}
          x2={WIDTH - PADDING.right}
          y1={PADDING.top + innerH + 0.5}
          y2={PADDING.top + innerH + 0.5}
          stroke="var(--line-2)"
          strokeWidth={1}
        />
        {points.map((point, i) => {
          const x = PADDING.left + i * (barW + gap);
          const base = PADDING.top + innerH;
          // Stacked dimmest-at-the-base so the bar reads as one brightness
          // ramp: cache writes → input → output (the product of the work).
          // See the fills in admin-v2-dashboard.css. Edges are placed from the
          // running sum, so the stack never outgrows the scale; a nonzero
          // segment keeps a hairline minimum only where headroom allows.
          const segments = [
            ["cache", point.cacheWrite] as const,
            ["input", point.input] as const,
            ["output", point.output] as const,
          ];
          let sum = 0;
          let top = base;
          return segments.map(([kind, value]) => {
            if (value <= 0) return null;
            sum += value;
            const bottom = top;
            top = Math.max(PADDING.top, Math.min(base - (sum / maxFresh) * innerH, bottom - 1));
            const y = top;
            const h = bottom - top;
            return h > 0 ? (
              <rect
                key={`${point.date}:${kind}`}
                className={`adm-token-seg adm-token-seg--${kind}`}
                x={x}
                y={y}
                width={barW}
                height={h}
                rx={1.5}
              />
            ) : null;
          });
        })}
      </svg>
      <div className="adm-dash-chart-axis" aria-hidden="true">
        {points.map((point) => <span key={point.date}>{formatChartDate(point.date, i18n.language)}</span>)}
      </div>
      <ul className="sr-only">
        {points.map((point) => (
          <li key={point.date}>
            {`${point.date}: ${t("admin.v2.dash_tokens_input")} ${numberFormat.format(point.input)}, ${t("admin.v2.dash_tokens_output")} ${numberFormat.format(point.output)}, ${t("admin.v2.dash_tokens_cache_write")} ${numberFormat.format(point.cacheWrite)}, ${t("admin.v2.dash_tokens_cache_read")} ${numberFormat.format(point.cacheRead)}`}
          </li>
        ))}
      </ul>
      <div className="adm-token-legend" role="group" aria-label={t("admin.v2.dash_tokens_legend")}>
        <span><i className="adm-token-dot adm-token-dot--output" aria-hidden="true" />{t("admin.v2.dash_tokens_output")}</span>
        <span><i className="adm-token-dot adm-token-dot--input" aria-hidden="true" />{t("admin.v2.dash_tokens_input")}</span>
        <span><i className="adm-token-dot adm-token-dot--cache" aria-hidden="true" />{t("admin.v2.dash_tokens_cache_write")}</span>
      </div>
      {coverageNote ? <CardDescription>{coverageNote}</CardDescription> : null}
    </Card>
  );
}
