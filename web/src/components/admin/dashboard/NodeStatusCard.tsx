"use client";

import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { displayTone, fleetSummary, type FleetSlot } from "../../../lib/fleetSlots";
import type { ControlPanelDaemonNodeRecord } from "../../../types";

interface NodeStatusCardProps {
  nodes: ControlPanelDaemonNodeRecord[];
  /** Commands waiting for a computer to pick them up. Not a node state, so it
   *  rides the header beside the title rather than the state list. */
  queued: number;
  onManageNodes: () => void;
  className?: string;
}

// Ring geometry, in the SVG's own units. A gap between arcs keeps two
// neighbouring states apart even when their hues sit close.
const SIZE = 120;
const STROKE = 12;
const RADIUS = (SIZE - STROKE) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
const ARC_GAP = 3;

export function NodeStatusCard({ nodes, queued, onManageNodes, className }: NodeStatusCardProps) {
  const { t } = useTranslation();
  const { slots, total, available } = useMemo(() => fleetSummary(nodes), [nodes]);
  const arcs = ringArcs(slots, total);
  const list = slots.filter((slot) => slot.key !== "unknown" || slot.count > 0);

  return (
    <Card render={<section />} className={className}>
      <CardHeader className="adm-dash-chart-head">
        <CardTitle render={<h2 />}>{t("admin.v2.dash_health_title")}</CardTitle>
        {queued > 0 ? (
          <span className="adm-dash-health-queued">{`${t("admin.control_panel.queued")} ${queued}`}</span>
        ) : null}
      </CardHeader>

      <div className="adm-dash-fleet">
        <div className="adm-dash-ring" role="img" aria-label={t("admin.v2.dash_health_title")}>
          <svg viewBox={`0 0 ${SIZE} ${SIZE}`} aria-hidden="true">
            <circle className="adm-dash-ring-track" cx={SIZE / 2} cy={SIZE / 2} r={RADIUS} strokeWidth={STROKE} />
            {arcs.map((arc) => (
              <circle
                key={arc.key}
                className={`adm-dash-ring-arc tone-${arc.tone}`}
                cx={SIZE / 2}
                cy={SIZE / 2}
                r={RADIUS}
                strokeWidth={STROKE}
                strokeDasharray={`${arc.length} ${CIRCUMFERENCE}`}
                strokeDashoffset={-arc.offset}
                transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}
              />
            ))}
          </svg>
          <div className="adm-dash-ring-center">
            <span className="adm-dash-ring-value tnum">{total > 0 ? `${available}/${total}` : "0"}</span>
            <span className="adm-dash-ring-label">{t("admin.v2.dash_health_available")}</span>
          </div>
        </div>

        <dl className="adm-dash-stat-grid">
          {list.map((slot) => (
            <div key={slot.key} className={`adm-dash-stat tone-${displayTone(slot)}`} data-empty={slot.count === 0 || undefined}>
              <dt className="adm-dash-stat-label">
                <span className="adm-dash-stat-dot" aria-hidden="true" />
                {t(`admin.v2.dash_health_${slot.key}`)}
              </dt>
              <dd className="adm-dash-stat-value tnum">{slot.count}</dd>
            </div>
          ))}
        </dl>
      </div>

      <CardFooter className="border-t adm-dash-health-footer">
        <CardDescription render={<span />}>
          {t("admin.v2.dash_health_total", { count: total })}
        </CardDescription>
        <Button variant="ghost" size="dense" onClick={onManageNodes}>
          {t("admin.control_panel.manage_fleet")}
          <span aria-hidden="true">↗</span>
        </Button>
      </CardFooter>
    </Card>
  );
}

function ringArcs(slots: readonly FleetSlot[], total: number) {
  if (total === 0) return [];
  const present = slots.filter((slot) => slot.count > 0);
  const gap = present.length > 1 ? ARC_GAP : 0;
  let offset = 0;
  return present.map((slot) => {
    const span = slot.share * CIRCUMFERENCE;
    const arc = { key: slot.key, tone: displayTone(slot), length: Math.max(span - gap, 1), offset };
    offset += span;
    return arc;
  });
}
