"use client";

import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import {
  Card,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { activityChartMetrics, type ActivityChartPoint } from "@/lib/activityChart";
import { formatChartDate } from "@/lib/chartDate";

interface ActivityChartProps {
  daily: ActivityChartPoint[];
  ready: boolean;
  error?: string | null;
  className?: string;
}

const WIDTH = 720;
const HEIGHT = 160;
const PADDING = { top: 12, right: 12, bottom: 24, left: 32 };

export function ActivityChart({ daily, ready, error, className }: ActivityChartProps) {
  const { t, i18n } = useTranslation();
  const lineRef = useRef<SVGPathElement>(null);
  const [lineLength, setLineLength] = useState(0);

  const { areaPath, linePath, gridLines, xTicks, dataPeak } = useMemo(() => {
    const points = (daily?.length ?? 0) > 0 ? daily! : Array.from({ length: 14 }, (_, i) => ({
      date: `d${i}`,
      count: 0,
      completed: 0,
      failed: 0,
    }));

    const innerW = WIDTH - PADDING.left - PADDING.right;
    const innerH = HEIGHT - PADDING.top - PADDING.bottom;
    const { dataPeak, scaleMax } = activityChartMetrics(daily);
    const step = innerW / Math.max(points.length - 1, 1);

    const coords = points.map((p, i) => {
      const x = PADDING.left + i * step;
      const y = PADDING.top + innerH - (p.count / scaleMax) * innerH;
      return { x, y };
    });

    const linePath = coords
      .map((c, i) => `${i === 0 ? "M" : "L"} ${c.x.toFixed(1)} ${c.y.toFixed(1)}`)
      .join(" ");

    const first = coords[0];
    const last = coords[coords.length - 1];
    const baselineY = PADDING.top + innerH;
    const areaPath =
      `M ${first.x.toFixed(1)} ${baselineY.toFixed(1)} ` +
      coords.map((c) => `L ${c.x.toFixed(1)} ${c.y.toFixed(1)}`).join(" ") +
      ` L ${last.x.toFixed(1)} ${baselineY.toFixed(1)} Z`;

    const gridLines = [0, 0.25, 0.5, 0.75, 1].map((f) => PADDING.top + innerH - f * innerH);
    const tickIndices = points.length > 7 ? [0, Math.floor(points.length / 2), points.length - 1] : points.map((_, i) => i);
    const xTicks = tickIndices.map((i) => {
      const c = coords[i];
      const label = formatChartDate(points[i].date, i18n.language);
      return { x: c.x, label };
    });

    return { areaPath, linePath, gridLines, xTicks, dataPeak };
  }, [daily, i18n.language]);

  useEffect(() => {
    const path = lineRef.current;
    if (!path) return;
    setLineLength(path.getTotalLength());
  }, [linePath]);

  return (
    <Card render={<section />} className={cn("adm-dash-card--chart", className)}>
      <CardHeader>
        <CardTitle render={<h2 />}>{t("admin.v2.dash_sessions_title")}</CardTitle>
      </CardHeader>
      <svg
        className="adm-dash-chart"
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        role="img"
        aria-label={t("admin.v2.dash_sessions_title")}
        preserveAspectRatio="none"
      >
        <defs>
          <linearGradient id="adm-dash-area" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--ink-3)" stopOpacity="0.18" />
            <stop offset="100%" stopColor="var(--ink-3)" stopOpacity="0" />
          </linearGradient>
        </defs>
        {gridLines.map((y, i) => (
          <line
            key={i}
            x1={PADDING.left}
            x2={WIDTH - PADDING.right}
            y1={y}
            y2={y}
            stroke="var(--line-2)"
            strokeWidth={1}
            strokeDasharray={i === gridLines.length - 1 ? "0" : "2 3"}
          />
        ))}
        <path d={areaPath} fill="url(#adm-dash-area)" className="adm-dash-chart-area" />
        <path
          ref={lineRef}
          d={linePath}
          fill="none"
          stroke="var(--ink-2)"
          strokeWidth={1.5}
          className="adm-dash-chart-line"
          style={lineLength > 0 ? { "--chart-path-length": `${lineLength}px` } as CSSProperties : undefined}
        />
      </svg>
      <div className="adm-dash-chart-axis" aria-hidden="true">
        {xTicks.map((tick) => <span key={`${tick.x}-${tick.label}`}>{tick.label}</span>)}
      </div>
      {(daily?.length ?? 0) > 0 ? (
        <ul className="sr-only">
          {daily.map((point) => (
            <li key={point.date}>
              {`${formatChartDate(point.date, i18n.language)}: ${point.count}`}
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
