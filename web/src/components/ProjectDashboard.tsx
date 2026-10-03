"use client";

import { skipToken, useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { projectIssueMetrics } from "../lib/projectDashboard";
import type { RelayTaskListItem } from "../types";
import { KpiTile } from "./admin/dashboard/KpiTile";

const formatDays = (days: number | null) => (days === null ? "—" : `${days.toFixed(1)}d`);

/** The project's readings over its issues. They used to ride the Issues
 *  board's header; the board now carries only the controls that act on it. */
export function ProjectDashboard({ tasks }: { tasks: RelayTaskListItem[] }) {
  const { t } = useTranslation();
  const metrics = useMemo(() => projectIssueMetrics(tasks), [tasks]);
  /* Read from the cache only: whichever surface fetched the flow policy
     seeded it, and the dashboard does not poll for it on its own. */
  const { data: policy } = useQuery<{ wipLimit: number; scope: string }>({
    queryKey: ["task-flow-policy"],
    queryFn: skipToken,
  });

  return (
    <div className="project-dashboard">
      <section className="project-dashboard-section" aria-labelledby="project-dashboard-issues">
        <h2 id="project-dashboard-issues" className="workspace-dossier-section-title">
          {t("project.dashboard_issues")}
        </h2>
        <div className="adm-dash-kpis" role="group" aria-label={t("backlog.metrics")}>
          <KpiTile eyebrow={t("backlog.metric_total")} value={metrics.total} />
          <KpiTile
            eyebrow={t("backlog.metric_active")}
            value={metrics.active}
            hint={policy ? t("project.dashboard_wip_limit", { count: policy.wipLimit }) : undefined}
          />
          <KpiTile eyebrow={t("backlog.metric_blocked")} value={metrics.blocked} />
          <KpiTile eyebrow={t("backlog.metric_overdue")} value={metrics.overdue} />
        </div>
      </section>

      <section className="project-dashboard-section" aria-labelledby="project-dashboard-flow">
        <h2 id="project-dashboard-flow" className="workspace-dossier-section-title">
          {t("project.dashboard_flow")}
        </h2>
        <div className="adm-dash-kpis" role="group" aria-label={t("project.dashboard_flow")}>
          <KpiTile eyebrow={t("backlog.oldest_age")} value={formatDays(metrics.oldestAgeDays)} />
          <KpiTile eyebrow={t("backlog.throughput")} value={metrics.throughput} />
          <KpiTile eyebrow={t("backlog.cycle_time")} value={formatDays(metrics.averageCycleDays)} />
          <KpiTile
            eyebrow={t(metrics.sleIsEstimate ? "backlog.sle_estimate" : "backlog.sle")}
            value={formatDays(metrics.sleDays)}
          />
        </div>
      </section>
    </div>
  );
}
