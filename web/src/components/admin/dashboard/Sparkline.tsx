"use client";

import { useId } from "react";

interface SparklineProps {
  points: readonly number[];
}

const W = 96;
const H = 32;
const INSET = 3;

/** A KPI's recent shape: line, soft fill, and a dot on today. Decorative —
 * the tile's numeral and its chart below carry the values. */
export function Sparkline({ points }: SparklineProps) {
  const gradientId = useId();
  if (points.length < 2) return null;
  const max = Math.max(...points);
  const min = Math.min(...points);
  const range = max - min || 1;
  const coords = points.map((value, index) => [
    (index / (points.length - 1)) * W,
    H - INSET - ((value - min) / range) * (H - INSET * 2),
  ] as const);
  const line = coords.map(([x, y], index) => `${index === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
  const [lastX, lastY] = coords[coords.length - 1];

  return (
    <svg className="adm-spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" className="adm-spark-stop" stopOpacity={0.3} />
          <stop offset="100%" className="adm-spark-stop" stopOpacity={0} />
        </linearGradient>
      </defs>
      <path d={`${line} L${W} ${H} L0 ${H} Z`} fill={`url(#${gradientId})`} />
      <path d={line} className="adm-spark-line" />
      <circle cx={lastX} cy={lastY} r={2.5} className="adm-spark-dot" />
    </svg>
  );
}
