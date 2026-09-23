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
import { visualStatus } from "../../../lib/adminHelpers";
import type { ControlPanelDaemonNodeRecord } from "../../../types";

interface NodeStatusCardProps {
  nodes: ControlPanelDaemonNodeRecord[];
  /** Commands waiting for a computer to pick them up. Not a node state, so it
   *  rides the footer beside the total rather than the state grid. */
  queued: number;
  onManageNodes: () => void;
  className?: string;
}

// Five states have to be distinguishable in an 8px bar. The olive brightness
// ramp alone cannot do it — ready and unknown are one step apart — so each
// tone is double-encoded by brightness and texture (see
// admin-v2-dashboard.css). "running" takes --live: a node running an agent is
// the one thing in Relay that is working right now, which is exactly what the
// live yellow is reserved for. There is no "info" tone left; running used to
// carry it and nothing else did.
type Tone = "live" | "good" | "bad" | "warn" | "neutral";
type Slot = { key: string; tone: Tone; count: number; share: number };

// One tone per state. `stale` used to share `bad` with `failed`, which rendered
// two different node conditions in the identical --err value — indistinguishable
// in both the meter and the dots. Stale is a warning (last-seen has lapsed), not
// a failure, so it takes the --warn step that the dashboard was not yet using.
const ORDER: Array<{ key: string; tone: Tone }> = [
  { key: "running", tone: "live" },
  { key: "ready", tone: "good" },
  { key: "failed", tone: "bad" },
  { key: "stale", tone: "warn" },
  { key: "unknown", tone: "neutral" },
];

export function NodeStatusCard({ nodes, queued, onManageNodes, className }: NodeStatusCardProps) {
  const { t } = useTranslation();

  const { slots, total } = useMemo(() => {
    const counts = new Map<string, number>();
    for (const node of nodes) {
      const key = visualStatus(node);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const total = nodes.length;
    const slots: Slot[] = ORDER.map(({ key, tone }) => {
      const count = counts.get(key) ?? 0;
      return { key, tone, count, share: total > 0 ? count / total : 0 };
    });
    return { slots, total };
  }, [nodes]);

  const segments = slots.filter((s) => s.count > 0);
  const grid = slots.filter((s) => s.key !== "unknown" || s.count > 0);

  return (
    <Card render={<section />} className={className}>
      <CardHeader>
        <CardTitle render={<h2 />}>{t("admin.v2.dash_health_title")}</CardTitle>
      </CardHeader>

      <div
        className="adm-dash-bar"
        role="img"
        aria-label={t("admin.v2.dash_health_title")}
      >
        {total === 0 ? (
          <span className="adm-dash-bar-empty" />
        ) : (
          segments.map((seg) => (
            <span
              key={seg.key}
              className={`adm-dash-bar-seg tone-${seg.tone}`}
              style={{ flexBasis: `${seg.share * 100}%` }}
              title={`${t(`admin.v2.dash_health_${seg.key}`)}: ${seg.count}`}
            />
          ))
        )}
      </div>

      <dl className="adm-dash-stat-grid">
        {grid.map((slot) => (
          // An idle fleet stays fully grey: --live means work in flight, so a
          // zero running count must not glow.
          <div
            key={slot.key}
            className={`adm-dash-stat tone-${slot.tone === "live" && slot.count === 0 ? "neutral" : slot.tone}`}
          >
            <dt className="adm-dash-stat-label">
              <span className="adm-dash-stat-dot" aria-hidden="true" />
              {t(`admin.v2.dash_health_${slot.key}`)}
            </dt>
            <dd className="adm-dash-stat-value tnum">{slot.count}</dd>
          </div>
        ))}
      </dl>

      {/* This card is the dashboard's only fleet readout. A band above the
          KPIs used to repeat four of these numbers and a KPI hint repeated two
          more, so one fact arrived three times in three shapes; the deep link
          and the queue depth were the only things the band owned, and they
          live here now. */}
      <CardFooter className="border-t adm-dash-health-footer">
        <CardDescription render={<span />}>
          {t("admin.v2.dash_health_total", { count: total })}
          {/* The separator rides with the clause it introduces, so a wrap
              cannot leave a "·" stranded at the end of the first line. */}
          {queued > 0 ? (
            <span className="adm-dash-health-queued">
              {` · ${t("admin.control_panel.queued")} ${queued}`}
            </span>
          ) : null}
        </CardDescription>
        <Button variant="ghost" size="dense" onClick={onManageNodes}>
          {t("admin.control_panel.manage_fleet")}
          <span aria-hidden="true">↗</span>
        </Button>
      </CardFooter>
    </Card>
  );
}
