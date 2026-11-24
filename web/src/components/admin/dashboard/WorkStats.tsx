"use client";

import { useTranslation } from "react-i18next";
import {
  Card,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { DashboardWorkResponse } from "../../../api";
import { formatCompact } from "../../../lib/compactNumber";

type StatTone = "good" | "live" | "warn" | "bad" | "info" | "neutral";
type SeriesKey = "1" | "2" | "3" | "rest";

interface BarSegment {
  key: string;
  tone?: StatTone;
  series?: SeriesKey;
  count: number;
}

interface StatRow {
  key: string;
  label: string;
  value: number;
  tone?: StatTone;
  series?: SeriesKey;
}

interface WorkStatsRowProps {
  data: DashboardWorkResponse;
  loading: boolean;
  error?: string | null;
}

function ProportionBar({ segments, total }: { segments: BarSegment[]; total: number }) {
  const present = segments.filter((segment) => segment.count > 0);
  if (total <= 0 || present.length === 0) {
    return (
      <span className="adm-dash-bar" aria-hidden="true">
        <span className="adm-dash-bar-empty" />
      </span>
    );
  }
  return (
    <span className="adm-dash-bar" aria-hidden="true">
      {present.map((segment) => (
        <span
          key={segment.key}
          className={`adm-dash-bar-seg${segment.tone ? ` tone-${segment.tone}` : ""}`}
          data-series={segment.series}
          style={{ flexBasis: `${(segment.count / total) * 100}%` }}
        />
      ))}
    </span>
  );
}

function WorkStatCard({
  title,
  badge,
  segments,
  barTotal,
  rows,
  footer,
  loading,
  error,
}: {
  title: string;
  badge?: string;
  segments: BarSegment[];
  barTotal: number;
  rows: StatRow[];
  footer: string;
  loading: boolean;
  error?: string | null;
}) {
  const { t, i18n } = useTranslation();
  return (
    <Card render={<section />} className="adm-dash-work-card">
      <CardHeader className="adm-dash-chart-head">
        <CardTitle render={<h2 />}>{title}</CardTitle>
        {!loading && !error && badge ? (
          <span className="adm-dash-work-total tnum">{badge}</span>
        ) : null}
      </CardHeader>
      {error ? (
        <CardDescription role="alert">{t("workspace.load_failed")}</CardDescription>
      ) : loading ? (
        <CardDescription role="status">{t("admin.v2.dash_loading")}</CardDescription>
      ) : (
        <>
          <div className="adm-dash-work-body">
            <ProportionBar segments={segments} total={barTotal} />
            <dl className="adm-dash-stat-grid">
              {rows.map((row) => (
                <div
                  key={row.key}
                  className={`adm-dash-stat${row.tone ? ` tone-${row.tone}` : ""}`}
                  data-series={row.series}
                  data-empty={row.value === 0 || undefined}
                >
                  <dt className="adm-dash-stat-label">
                    <span className="adm-dash-stat-dot" aria-hidden="true" />
                    {row.label}
                  </dt>
                  <dd className="adm-dash-stat-value tnum" title={row.value.toLocaleString(i18n.language)}>
                    {formatCompact(row.value, i18n.language)}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
          <CardFooter className="border-t adm-dash-work-footer">
            <CardDescription render={<span />}>{footer}</CardDescription>
          </CardFooter>
        </>
      )}
    </Card>
  );
}

export function WorkStatsRow({ data, loading, error }: WorkStatsRowProps) {
  const { t, i18n } = useTranslation();
  const format = (value: number) => formatCompact(value, i18n.language);
  const { projects, tasks, conversations } = data;

  const projectAll = projects.total + projects.archived;
  const projectOtherEnabled = Math.max(0, projects.enabled - projects.activeInRange);
  const taskRest = tasks.backlog + tasks.cancelled;

  return (
    <div className="adm-dash-work-row">
      <WorkStatCard
        title={t("admin.v2.dash_work_projects_title")}
        badge={t("admin.v2.dash_work_projects_total", { count: projects.total })}
        barTotal={projectAll}
        segments={[
          { key: "active", series: "1", count: projects.activeInRange },
          { key: "enabled", tone: "good", count: projectOtherEnabled },
          { key: "disabled", tone: "warn", count: projects.disabled },
          { key: "archived", series: "rest", count: projects.archived },
        ]}
        rows={[
          { key: "active", label: t("admin.v2.dash_work_projects_active"), value: projects.activeInRange, series: "1" },
          { key: "created", label: t("admin.v2.dash_work_projects_created"), value: projects.created, series: "2" },
          { key: "enabled", label: t("admin.v2.dash_work_projects_enabled"), value: projects.enabled, tone: "good" },
          { key: "archived", label: t("admin.v2.dash_work_projects_archived"), value: projects.archived, series: "rest" },
        ]}
        footer={t("admin.v2.dash_work_projects_footer", {
          enabled: format(projects.enabled),
          disabled: format(projects.disabled),
          archived: format(projects.archived),
        })}
        loading={loading}
        error={error}
      />

      <WorkStatCard
        title={t("admin.v2.dash_work_tasks_title")}
        badge={t("admin.v2.dash_work_tasks_created", { count: tasks.created })}
        barTotal={tasks.created}
        segments={[
          { key: "done", tone: "good", count: tasks.done },
          { key: "inProgress", tone: "live", count: tasks.inProgress },
          { key: "blocked", tone: "bad", count: tasks.blocked },
          { key: "rest", series: "rest", count: taskRest },
        ]}
        rows={[
          { key: "done", label: t("admin.v2.dash_work_tasks_done"), value: tasks.done, tone: "good" },
          {
            key: "inProgress",
            label: t("admin.v2.dash_work_tasks_in_progress"),
            value: tasks.inProgress,
            tone: tasks.inProgress > 0 ? "live" : "neutral",
          },
          {
            key: "blocked",
            label: t("admin.v2.dash_work_tasks_blocked"),
            value: tasks.blocked,
            tone: tasks.blocked > 0 ? "bad" : "neutral",
          },
          { key: "backlog", label: t("admin.v2.dash_work_tasks_backlog"), value: tasks.backlog, series: "rest" },
          { key: "cancelled", label: t("admin.v2.dash_work_tasks_cancelled"), value: tasks.cancelled, tone: "neutral" },
        ]}
        footer={t("admin.v2.dash_work_tasks_footer", {
          inProjects: format(tasks.inProjects),
          standalone: format(tasks.standalone),
          total: format(tasks.total),
        })}
        loading={loading}
        error={error}
      />

      <WorkStatCard
        title={t("admin.v2.dash_work_conversations_title")}
        badge={t("admin.v2.dash_work_conversations_chats", { count: conversations.chats })}
        barTotal={conversations.total}
        segments={[
          { key: "projectChats", series: "1", count: conversations.projectChats },
          { key: "standaloneChats", series: "2", count: conversations.standaloneChats },
          { key: "taskRuns", tone: "good", count: conversations.taskRuns },
          { key: "automationRuns", series: "rest", count: conversations.automationRuns },
        ]}
        rows={[
          {
            key: "projectChats",
            label: t("admin.v2.dash_work_conversations_project"),
            value: conversations.projectChats,
            series: "1",
          },
          {
            key: "standaloneChats",
            label: t("admin.v2.dash_work_conversations_standalone"),
            value: conversations.standaloneChats,
            series: "2",
          },
          {
            key: "taskRuns",
            label: t("admin.v2.dash_work_conversations_task_runs"),
            value: conversations.taskRuns,
            tone: "good",
          },
          {
            key: "automationRuns",
            label: t("admin.v2.dash_work_conversations_automation_runs"),
            value: conversations.automationRuns,
            series: "rest",
          },
        ]}
        footer={t("admin.v2.dash_work_conversations_footer", { count: conversations.totalChats })}
        loading={loading}
        error={error}
      />
    </div>
  );
}
