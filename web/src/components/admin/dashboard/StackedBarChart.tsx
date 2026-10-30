"use client";

import { useState } from "react";
import { axisTicks, niceScaleMax } from "@/lib/activityChart";

export interface ChartSeries {
  key: string;
  label: string;
}

export interface ChartColumn {
  key: string;
  label: string;
  values: Readonly<Record<string, number>>;
}

interface StackedBarChartProps {
  columns: readonly ChartColumn[];
  /** Base of the stack first. Each key paints through `.adm-series--<key>`. */
  series: readonly ChartSeries[];
  format: (value: number) => string;
  ariaLabel: string;
  /** Lowest scale ceiling, so a quiet window does not blow tiny bars up. */
  floor?: number;
  /** Bar width as a share of its column. */
  barRatio?: number;
  /** Label every n-th column, counted back from the last (today), so the
   *  newest day is always named and no two labels crowd each other. */
  labelEvery?: number;
  totalLabel: (column: ChartColumn, total: number) => string;
  className?: string;
}

// The plot draws in a 100×100 box stretched to the card, so bars and
// gridlines scale with it; every text label is HTML, positioned by percent,
// so nothing typographic is ever stretched.
const BOX = 100;

export function StackedBarChart({
  columns, series, format, ariaLabel, floor = 1, barRatio = 0.6, labelEvery = 1, totalLabel, className,
}: StackedBarChartProps) {
  const [active, setActive] = useState<number | null>(null);
  const totals = columns.map((column) => series.reduce((sum, s) => sum + (column.values[s.key] ?? 0), 0));
  const max = niceScaleMax(Math.max(0, ...totals), floor);
  const ticks = axisTicks(max);
  const slot = BOX / Math.max(1, columns.length);
  const barW = slot * barRatio;
  const activeColumn = active === null ? null : columns[active];

  return (
    <div className={`adm-chart${className ? ` ${className}` : ""}`}>
      <div className="adm-chart-y" aria-hidden="true">
        {ticks.map((tick) => (
          <span key={tick} style={{ bottom: `${(tick / max) * 100}%` }}>{format(tick)}</span>
        ))}
      </div>
      <div className="adm-chart-plot" onMouseLeave={() => setActive(null)}>
        <svg className="adm-chart-svg" viewBox={`0 0 ${BOX} ${BOX}`} preserveAspectRatio="none" role="img" aria-label={ariaLabel}>
          {ticks.map((tick, index) => {
            const y = BOX - (tick / max) * BOX;
            return (
              <line
                key={tick}
                className={index === 0 ? "adm-chart-baseline" : "adm-chart-grid"}
                x1={0}
                x2={BOX}
                y1={y}
                y2={y}
                vectorEffect="non-scaling-stroke"
              />
            );
          })}
          {columns.map((column, index) => (
            <g key={column.key}>
              {stackSegments(column, series, max).map((segment) => (
                <rect
                  key={segment.key}
                  className={`adm-series adm-series--${segment.key}`}
                  x={index * slot + (slot - barW) / 2}
                  y={segment.y}
                  width={barW}
                  height={segment.height}
                  vectorEffect="non-scaling-stroke"
                />
              ))}
            </g>
          ))}
        </svg>
        <div className="adm-chart-hit" aria-hidden="true">
          {columns.map((column, index) => (
            <span
              key={column.key}
              data-active={active === index || undefined}
              onMouseEnter={() => setActive(index)}
            />
          ))}
        </div>
        {activeColumn && active !== null ? (
          <div
            className="adm-chart-tip"
            aria-hidden="true"
            data-edge={active === 0 ? "start" : active === columns.length - 1 ? "end" : undefined}
            style={{ left: `${((active + 0.5) / columns.length) * 100}%` }}
          >
            <div className="adm-chart-tip-title">{totalLabel(activeColumn, totals[active])}</div>
            {[...series].reverse().map((s) => (
              <div key={s.key} className="adm-chart-tip-row">
                <span><i className={`adm-swatch adm-series--${s.key}`} />{s.label}</span>
                <span className="tnum">{format(activeColumn.values[s.key] ?? 0)}</span>
              </div>
            ))}
          </div>
        ) : null}
      </div>
      <div className="adm-chart-x" aria-hidden="true">
        {columns.map((column, index) => (
          <span key={column.key}>
            {(columns.length - 1 - index) % labelEvery === 0 ? column.label : ""}
          </span>
        ))}
      </div>
    </div>
  );
}

interface ChartLegendProps {
  label: string;
  /** Top of the stack first, as a reader scans it. */
  items: ReadonlyArray<{ key: string; label: string; total: string }>;
}

export function ChartLegend({ label, items }: ChartLegendProps) {
  return (
    <div className="adm-chart-legend" role="group" aria-label={label}>
      {items.map((item) => (
        <span key={item.key}>
          <i className={`adm-swatch adm-series--${item.key}`} aria-hidden="true" />
          {item.label}
          <strong className="tnum">{item.total}</strong>
        </span>
      ))}
    </div>
  );
}

function stackSegments(column: ChartColumn, series: readonly ChartSeries[], max: number) {
  let sum = 0;
  return series.flatMap((s) => {
    const value = column.values[s.key] ?? 0;
    if (value <= 0) return [];
    const bottom = BOX - (sum / max) * BOX;
    sum += value;
    const top = Math.max(0, BOX - (sum / max) * BOX);
    return [{ key: s.key, y: top, height: Math.max(bottom - top, 0.4) }];
  });
}
