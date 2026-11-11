"use client";

import { skipToken, useQuery } from "@tanstack/react-query";
import { useMemo, type ReactNode } from "react";
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
  type ProjectIssueMetrics,
} from "../lib/projectDashboard";
import { taskRef } from "../lib/taskRef";
import type { RelayTaskListItem } from "../types";
import { KpiTile } from "./admin/dashboard/KpiTile";
import { ICON, NavProjects } from "./icons";
import { formatDueDate } from "./task-board/BacklogChrome";
import { WorkspaceEmpty } from "./workspace/WorkspacePrimitives";

interface ProjectDashboardProps {
  /** Who runs the project, shown above its numbers (`ProjectManagerLine`). */
  steward?: ReactNode;
  /** A drafted proposal waiting on the owner (`ProjectSetupPanel`); it leads
   *  the page, since nothing else moves until it is applied or discarded. */
  review?: ReactNode;
  /** What the project's agents propose and the way to ask them — the
   *  context suggestions and the plan/refine request. A column beside the
   *  attention list on a wide pane, below it on a narrow one. */
  proposals?: ReactNode;
  tasks: RelayTaskListItem[];
  onOpenRecord: (taskId: string) => void;
  onOpenBoard: () => void;
}

/** The project at a glance: four counts, the issues that need a look, and
 *  what its agents propose. Flow readings (cycle time, throughput) and a
 *  per-stage breakdown used to sit here too; for a project of a handful of
 *  issues they restated these four tiles, so the board's own columns carry
 *  the stages instead. */
export function ProjectDashboard({ steward, review, proposals, tasks, onOpenRecord, onOpenBoard }: ProjectDashboardProps) {
  const { t } = useTranslation();
  const metrics = useMemo(() => projectIssueMetrics(tasks), [tasks]);
  const attention = useMemo(() => projectAttentionIssues(tasks, undefined, Infinity), [tasks]);
  /* Read from the cache only: whichever surface fetched the flow policy
     seeded it, and the dashboard does not poll for it on its own. */
  const { data: policy } = useQuery<{ wipLimit: number; scope: string }>({
    queryKey: ["task-flow-policy"],
    queryFn: skipToken,
  });

  const { data: usage } = useQuery<{ userId: string; occupied: number }>({
    queryKey: ["task-flow-usage"],
    queryFn: skipToken,
  });
  const capacity = policy && usage ? (
    <div className="project-dashboard-capacity">
      <p>{t("project.dashboard_user_wip", { count: usage.occupied, limit: policy.wipLimit })}</p>
      <Button type="button" variant="ghost" size="dense" onClick={onOpenBoard}>
        {t("project.dashboard_view_project_tasks")}
      </Button>
    </div>
  ) : null;

  const empty = metrics.total === 0;
  const main = empty ? (
    /* No issues yet: one note and the way to the board, instead of a rail
       of zeros. The proposals column stays, since asking the lead for a plan
       is the natural first step in an empty project. */
    <div className="project-dashboard-empty">
      <WorkspaceEmpty
        title={t("project.dashboard_empty")}
        hint={t("project.dashboard_empty_hint")}
        mark={<span className="project-mark" aria-hidden="true"><NavProjects size={ICON.md} /></span>}
      />
      <Button type="button" variant="outline" size="dense" onClick={onOpenBoard}>
        {t("project.dashboard_open_board")}
      </Button>
    </div>
  ) : (
    <AttentionCard issues={attention} onOpenRecord={onOpenRecord} onOpenBoard={onOpenBoard} />
  );

  return (
    <div className="project-dashboard">
      {steward}
      {review}
      {empty ? null : <ProgressRail metrics={metrics} />}
      {capacity}
      <div className="project-dashboard-body">
        <div className="project-dashboard-main">{main}</div>
        {proposals ? <div className="project-dashboard-aside">{proposals}</div> : null}
      </div>
    </div>
  );
}

/** The four counts. Total carries the project's mix as a meter — done, in
 *  progress, blocked — so progress reads before any number does. */
function ProgressRail({ metrics }: { metrics: ProjectIssueMetrics }) {
  const { t } = useTranslation();
  const completedPercent = Math.round((metrics.done / metrics.total) * 100);
  const segments = [
    { key: "done", tone: "good", count: metrics.done },
    { key: "active", tone: "live", count: metrics.active },
    { key: "blocked", tone: "bad", count: metrics.blocked },
  ].filter((segment) => segment.count > 0);
  return (
    <div className="adm-dash-kpis adm-dash-kpis--lean" role="group" aria-label={t("backlog.metrics")}>
      <KpiTile
        eyebrow={t("backlog.metric_total")}
        value={metrics.total}
        visual={(
          <span className="adm-dash-bar adm-dash-tile-meter" aria-hidden="true">
            {segments.map((segment) => (
              <span
                key={segment.key}
                className={`adm-dash-bar-seg tone-${segment.tone}`}
                style={{ flexBasis: `${(segment.count / metrics.total) * 100}%` }}
              />
            ))}
          </span>
        )}
        hint={t("project.dashboard_completed_share", { percent: completedPercent })}
      />
      <KpiTile
        eyebrow={t("backlog.metric_active")}
        value={metrics.active}
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
      {/* The way to the rest appears only when the card held some back; with
          nothing hidden it repeated the Tasks tab one row above it. */}
      {hidden > 0 ? (
        <CardFooter className="border-t adm-dash-health-footer">
          <CardDescription render={<span />}>
            {t("project.dashboard_attention_more", { count: hidden })}
          </CardDescription>
          <Button variant="ghost" size="dense" onClick={onOpenBoard}>
            {t("project.dashboard_open_board")}
          </Button>
        </CardFooter>
      ) : null}
    </Card>
  );
}
