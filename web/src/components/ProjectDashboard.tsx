"use client";

import { skipToken, useQuery } from "@tanstack/react-query";
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
import {
  PROJECT_ATTENTION_LIMIT,
  projectAttentionIssues,
  projectIssueMetrics,
  type ProjectAttentionIssue,
} from "../lib/projectDashboard";
import { taskRef } from "../lib/taskRef";
import type { RelayTaskListItem } from "../types";
import { KpiTile } from "./admin/dashboard/KpiTile";
import { ICON, NavProjects } from "./icons";
import { formatDueDate } from "./task-board/BacklogChrome";
import { WorkspaceEmpty } from "./workspace/WorkspacePrimitives";

interface ProjectDashboardProps {
  tasks: RelayTaskListItem[];
  onOpenRecord: (taskId: string) => void;
  onOpenBoard: () => void;
}

/** The project at a glance: four counts and the issues that need a look.
 *  Flow readings (cycle time, throughput) and a per-stage breakdown used to
 *  sit here too; for a project of a handful of issues they restated these
 *  four tiles, so the board's own columns carry the stages instead. */
export function ProjectDashboard({ tasks, onOpenRecord, onOpenBoard }: ProjectDashboardProps) {
  const { t } = useTranslation();
  const metrics = useMemo(() => projectIssueMetrics(tasks), [tasks]);
  const attention = useMemo(() => projectAttentionIssues(tasks, undefined, Infinity), [tasks]);
  /* Read from the cache only: whichever surface fetched the flow policy
     seeded it, and the dashboard does not poll for it on its own. */
  const { data: policy } = useQuery<{ wipLimit: number; scope: string }>({
    queryKey: ["task-flow-policy"],
    queryFn: skipToken,
  });

  if (metrics.total === 0) {
    return (
      <div className="project-dashboard project-dashboard--empty">
        <WorkspaceEmpty
          title={t("project.dashboard_empty")}
          hint={t("project.dashboard_empty_hint")}
          mark={<span className="project-mark" aria-hidden="true"><NavProjects size={ICON.md} /></span>}
        />
        <Button type="button" variant="outline" size="dense" onClick={onOpenBoard}>
          {t("project.dashboard_open_board")}
        </Button>
      </div>
    );
  }

  const completedPercent = Math.round((metrics.done / metrics.total) * 100);

  return (
    <div className="project-dashboard">
      <div className="adm-dash-kpis" role="group" aria-label={t("backlog.metrics")}>
        <KpiTile
          eyebrow={t("backlog.metric_total")}
          value={metrics.total}
          hint={t("project.dashboard_completed_share", { percent: completedPercent })}
        />
        <KpiTile
          eyebrow={t("backlog.metric_active")}
          value={metrics.active}
          hint={policy ? t("project.dashboard_wip_limit", { count: policy.wipLimit }) : undefined}
        />
        <KpiTile
          eyebrow={t("backlog.metric_blocked")}
          value={metrics.blocked}
          tone={metrics.blocked > 0 ? "bad" : undefined}
        />
        <KpiTile
          eyebrow={t("backlog.metric_overdue")}
          value={metrics.overdue}
          tone={metrics.overdue > 0 ? "bad" : undefined}
        />
      </div>

      <AttentionCard issues={attention} onOpenRecord={onOpenRecord} onOpenBoard={onOpenBoard} />
    </div>
  );
}

function AttentionCard({
  issues,
  onOpenRecord,
  onOpenBoard,
}: {
  issues: ProjectAttentionIssue[];
  onOpenRecord: (taskId: string) => void;
  onOpenBoard: () => void;
}) {
  const { t } = useTranslation();
  const shown = issues.slice(0, PROJECT_ATTENTION_LIMIT);
  const hidden = issues.length - shown.length;
  return (
    <Card render={<section />} className="project-dashboard-card">
      <CardHeader>
        <CardTitle render={<h2 />}>{t("project.dashboard_attention")}</CardTitle>
      </CardHeader>
      {shown.length === 0 ? (
        <p className="project-dashboard-attention-empty">{t("project.dashboard_attention_empty")}</p>
      ) : (
        <ul className="project-dashboard-attention">
          {shown.map(({ task, reason, overdue }) => (
            <li key={task.id}>
              <button
                type="button"
                className="project-dashboard-attention-row tone-bad"
                onClick={() => onOpenRecord(task.id)}
              >
                <span className="project-dashboard-attention-dot" aria-hidden="true" />
                <span className="project-dashboard-attention-title" title={task.title}>
                  <span className="code project-dashboard-attention-ref" translate="no">{taskRef(task)}</span>
                  {task.title}
                </span>
                <span className="project-dashboard-attention-reason">
                  {[
                    reason === "blocked" ? t("backlog.statuses.blocked") : null,
                    overdue ? `${t("backlog.metric_overdue")} ${formatDueDate(task.dueDate!)}` : null,
                  ].filter(Boolean).join(" · ")}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <CardFooter className="border-t adm-dash-health-footer">
        <CardDescription render={<span />}>
          {hidden > 0 ? t("project.dashboard_attention_more", { count: hidden }) : null}
        </CardDescription>
        <Button variant="ghost" size="dense" onClick={onOpenBoard}>
          {t("project.dashboard_open_board")}
        </Button>
      </CardFooter>
    </Card>
  );
}
