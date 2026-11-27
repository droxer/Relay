"use client";

import type { MouseEvent, ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { ICON, StatusOk } from "../icons";
import { StateMark } from "../StateMark";
import { PROJECT_PROGRESS, type HomeProjectRow, type RunningRow } from "../../lib/homeSummary";
import { taskRef } from "../../lib/taskRef";
import type { RelayTaskListItem } from "../../types";

/** An in-app link: a real href for new tabs, client navigation otherwise. */
export function HomeLink({ href, onOpen, className, children }: { href: string; onOpen: () => void; className?: string; children: ReactNode }) {
  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    onOpen();
  };
  return <a className={className} href={href} onClick={onClick}>{children}</a>;
}

export function CardHeader({ id, title, count, more }: { id: string; title: string; count?: ReactNode; more?: ReactNode }) {
  return (
    <header className="home-card-header">
      <div className="home-card-heading">
        <h2 id={id} className="home-card-title">{title}</h2>
        {count !== undefined ? <span className="home-section-count tnum">{count}</span> : null}
      </div>
      {more ? <span className="home-card-more">{more}</span> : null}
    </header>
  );
}

const PROJECTS_PREVIEW = 4;

export function ProjectsPanel({ rows, nextLabel, hrefFor, onOpen, allHref, onOpenAll, onNewProject }: {
  rows: readonly HomeProjectRow[];
  nextLabel: (row: HomeProjectRow) => string;
  hrefFor: (row: HomeProjectRow) => string;
  onOpen: (row: HomeProjectRow) => void;
  allHref: string;
  onOpenAll: () => void;
  onNewProject: () => void;
}) {
  const { t } = useTranslation();
  const visible = rows.slice(0, PROJECTS_PREVIEW);
  const more = <HomeLink className="home-link" href={allHref} onOpen={onOpenAll}>{t("home.all_projects")}</HomeLink>;
  if (visible.length === 0) {
    return (
      <section className="home-card" aria-labelledby="home-projects-title">
        <CardHeader id="home-projects-title" title={t("home.projects")} more={more} />
        <div className="home-clear">
          <p className="home-clear-body">{t("home.no_projects")}</p>
          <Button type="button" variant="outline" size="dense" onClick={onNewProject}>{t("home.new_project")}</Button>
        </div>
      </section>
    );
  }
  return (
    <section className="home-card" aria-labelledby="home-projects-title">
      <CardHeader id="home-projects-title" title={t("home.projects")} count={rows.length} more={more} />
      <ul className="home-list home-projects">
        {visible.map((row) => {
          const share = (count: number) => (row.total ? (count / row.total) * 100 : 0);
          const done = Math.round(share(row.progress.done));
          return (
            <li key={row.project.id}>
              <HomeLink className="home-project" href={hrefFor(row)} onOpen={() => onOpen(row)}>
                <span className="home-project-head">
                  <span className="home-project-name">{row.project.name}</span>
                  <span className="home-project-pct tnum">{t("home.percent_done", { percent: done })}</span>
                </span>
                <span
                  className="home-project-bar"
                  role="img"
                  aria-label={[
                    t("home.task_count", { count: row.total }),
                    ...PROJECT_PROGRESS.map((status) => `${row.progress[status]} ${t(`home.stage.${status}`)}`),
                  ].join(", ")}
                >
                  {PROJECT_PROGRESS.map((status) => (row.progress[status]
                    ? <span key={status} className="home-project-seg" data-stage={status} style={{ width: `${share(row.progress[status])}%` }} />
                    : null))}
                </span>
                <span className="home-project-facts">
                  <span>{t("home.task_count", { count: row.total })}</span>
                  {row.progress.running ? <span data-tone="live">{t("home.running_count", { count: row.progress.running })}</span> : null}
                  {row.waitingOnYou ? <span data-tone="warn">{t("home.waiting_count", { count: row.waitingOnYou })}</span> : null}
                  {row.progress.blocked ? <span data-tone="err">{t("home.blocked_count", { count: row.progress.blocked })}</span> : null}
                </span>
                <span className="home-project-next">{nextLabel(row)}</span>
              </HomeLink>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export function RunningPanel({ rows, title, agentName, computerName, elapsed, hrefFor, onOpen, allHref, onOpenAll }: {
  rows: readonly RunningRow[];
  title: (row: RunningRow) => string;
  agentName: (row: RunningRow) => string | null;
  computerName: (row: RunningRow) => string | null;
  elapsed: (iso: string) => string;
  hrefFor: (row: RunningRow) => string;
  onOpen: (row: RunningRow) => void;
  allHref: string;
  onOpenAll: () => void;
}) {
  const { t } = useTranslation();
  const more = <HomeLink className="home-link" href={allHref} onOpen={onOpenAll}>{t("home.all_threads")}</HomeLink>;
  return (
    <section className="home-card" aria-labelledby="home-running-title">
      <CardHeader id="home-running-title" title={t("home.running_now")} count={rows.length} more={more} />
      {rows.length === 0 ? (
        <p className="home-card-empty">{t("home.no_running")}</p>
      ) : (
        <ul className="home-list home-runs">
          {rows.map((row) => {
            const agent = agentName(row);
            const computer = computerName(row);
            return (
              <li key={row.session.id}>
                <HomeLink className="home-run" href={hrefFor(row)} onOpen={() => onOpen(row)}>
                  <StateMark className="home-run-mark" tone={row.paused ? "warn" : "live"} />
                  <span className="home-run-body">
                    <span className="home-run-title">{title(row)}</span>
                    <span className="home-run-sub">
                      {[agent, computer].filter(Boolean).join(" · ")}
                      {row.paused ? <span className="home-run-paused"> · {t("home.paused_for_permission")}</span> : null}
                    </span>
                  </span>
                  <span className="home-run-time tnum">{elapsed(row.startedAt)}</span>
                </HomeLink>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

export function FinishedPanel({ tasks, sinceLabel, hrefFor, onOpen }: {
  tasks: readonly RelayTaskListItem[];
  sinceLabel: (iso: string) => string;
  hrefFor: (task: RelayTaskListItem) => string;
  onOpen: (task: RelayTaskListItem) => void;
}) {
  const { t } = useTranslation();
  return (
    <section className="home-card" aria-labelledby="home-finished-title">
      <CardHeader id="home-finished-title" title={t("home.recently_finished")} count={tasks.length} />
      {tasks.length === 0 ? (
        <p className="home-card-empty">{t("home.no_finished")}</p>
      ) : (
        <ul className="home-list home-finished">
          {tasks.map((task) => (
            <li key={task.id}>
              <HomeLink className="home-finished-row" href={hrefFor(task)} onOpen={() => onOpen(task)}>
                <span className="home-finished-glyph" aria-hidden="true">
                  <StatusOk size={ICON.sm} />
                </span>
                <span className="home-finished-title">
                  <span className="home-item-ref">{taskRef(task)}</span>
                  {task.title}
                </span>
                <span className="home-finished-meta tnum">{sinceLabel(task.finishedAt ?? task.updatedAt)}</span>
              </HomeLink>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
