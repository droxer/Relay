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
import { TASK_FLOW_STAGES, type TaskWorkflowStage } from "../lib/taskFlow";
import { taskRef } from "../lib/taskRef";
import type { RelayTaskListItem } from "../types";
import { KpiTile } from "./admin/dashboard/KpiTile";
import { ICON, NavProjects } from "./icons";
import { formatDueDate } from "./task-board/BacklogChrome";
import { WorkspaceEmpty } from "./workspace/WorkspacePrimitives";

const formatDays = (days: number | null) => (days === null ? "—" : `${days.toFixed(1)}d`);

/* Five stages have to separate in one 8px bar, so each takes its own tone
   (warn is textured as well, see admin-v2-dashboard.css). In progress takes
   --live, which is reserved for work in flight and goes grey at zero. */
type StageTone = "neutral" | "info" | "live" | "warn" | "good";
const STAGE_TONE: Record<TaskWorkflowStage, StageTone> = {
  backlog: "neutral",
  assigned: "info",
  running: "live",
  review: "warn",
  done: "good",
};

interface ProjectDashboardProps {
  tasks: RelayTaskListItem[];
  onOpenRecord: (taskId: string) => void;
  onOpenBoard: () => void;
}

/** The project's readings over its issues, and the ones that need a look.
 *  They used to ride the Issues board's header; the board now carries only
 *  the controls that act on it. */
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
      <section className="project-dashboard-section" aria-labelledby="project-dashboard-issues">
        <h2 id="project-dashboard-issues" className="workspace-dossier-section-title">
          {t("project.dashboard_issues")}
        </h2>
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

      <div className="project-dashboard-cards">
        <StageCard stages={metrics.stages} total={metrics.total} />
        <AttentionCard issues={attention} onOpenRecord={onOpenRecord} onOpenBoard={onOpenBoard} />
      </div>
    </div>
  );
}

function StageCard({ stages, total }: { stages: Record<TaskWorkflowStage, number>; total: number }) {
  const { t } = useTranslation();
  const toneOf = (stage: TaskWorkflowStage) =>
    STAGE_TONE[stage] === "live" && stages[stage] === 0 ? "neutral" : STAGE_TONE[stage];
  return (
    <Card render={<section />} className="project-dashboard-card project-dashboard-stage-card">
      <CardHeader>
        <CardTitle render={<h2 />}>{t("project.dashboard_stages")}</CardTitle>
      </CardHeader>
      <div className="adm-dash-bar" role="img" aria-label={t("project.dashboard_stages")}>
        {TASK_FLOW_STAGES.filter((stage) => stages[stage] > 0).map((stage) => (
          <span
            key={stage}
            className={`adm-dash-bar-seg tone-${toneOf(stage)}`}
            style={{ flexBasis: `${(stages[stage] / total) * 100}%` }}
            title={`${t(`backlog.statuses.${stage}`)}: ${stages[stage]}`}
          />
        ))}
      </div>
      <dl className="adm-dash-stat-grid project-dashboard-stage-grid">
        {TASK_FLOW_STAGES.map((stage) => (
          <div key={stage} className={`adm-dash-stat tone-${toneOf(stage)}`}>
            <dt className="adm-dash-stat-label">
              <span className="adm-dash-stat-dot" aria-hidden="true" />
              {t(`backlog.statuses.${stage}`)}
            </dt>
            <dd className="adm-dash-stat-value tnum">{stages[stage]}</dd>
          </div>
        ))}
      </dl>
    </Card>
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
                <span className="project-dashboard-attention-title">
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
          <span aria-hidden="true">→</span>
        </Button>
      </CardFooter>
    </Card>
  );
}
