"use client";

import { useState, type MouseEvent } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { ActionAdd, DisclosureChevron, ICON } from "./icons";
import { StateMark } from "./StateMark";
import { TASK_STATUS_SHAPE } from "./task-board/backlogVocabulary";
import type { ProjectRecord, RelayTaskListItem } from "../types";
import type { ProjectCollectionStatus } from "../lib/projectPage";

export function projectTasksHref(projectId: string | null, taskId?: string): string {
  const path = taskId ? `/backlog/${encodeURIComponent(taskId)}` : "/backlog";
  return projectId ? `${path}?project=${encodeURIComponent(projectId)}` : path;
}

function navigateLink(event: MouseEvent<HTMLAnchorElement>, action: () => void) {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
  event.preventDefault();
  action();
}

export function ProjectTaskNav({ projects, tasks, projectId, taskId, onOpenTask, onSelect, onCreate, status, onRetry }: {
  projects: ProjectRecord[];
  tasks: RelayTaskListItem[];
  projectId: string | null;
  taskId?: string | null;
  onOpenTask?: (id: string, projectId: string) => void;
  onSelect: (id: string | null) => void;
  onCreate: () => void;
  status: ProjectCollectionStatus;
  onRetry: () => void;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const visible = projects.filter((project) => !project.archivedAt || project.id === projectId);
  const grouped = new Map<string, RelayTaskListItem[]>();
  for (const task of tasks) {
    if (task.projectId && !task.deletedAt && !task.isRoutine) {
      const group = grouped.get(task.projectId) ?? [];
      group.push(task);
      grouped.set(task.projectId, group);
    }
  }
  return (
    <aside className="task-project-nav" aria-label={t("project.projects")}>
      <div className="task-project-nav-desktop">
        <h2 className="task-project-nav-title">{t("nav.backlog")}</h2>
        <nav aria-label={t("project.grouped_tasks")}>
          <a className="sec-nav-btn" href="/backlog" data-active={!projectId && !taskId ? "true" : "false"}
            aria-current={!projectId && !taskId ? "page" : undefined}
            onClick={(event) => navigateLink(event, () => onSelect(null))}>{t("project.all_projects")}</a>
          {visible.map((project) => {
            const work = grouped.get(project.id) ?? [];
            const open = expanded[project.id] ?? (!project.archivedAt || projectId === project.id);
            const groupId = `task-project-${project.id}`;
            return (
              <section className="task-nav-group" key={project.id} aria-label={project.name}>
                <div className="task-nav-group-heading">
                  <Button variant="ghost" size="icon" aria-label={project.name} aria-expanded={open} aria-controls={groupId}
                    onClick={() => setExpanded((current) => ({ ...current, [project.id]: !open }))}>
                    <DisclosureChevron size={ICON.sm} className={open ? "task-nav-chevron-open" : undefined} />
                  </Button>
                  <a className="sec-nav-btn" href={projectTasksHref(project.id)}
                    data-active={projectId === project.id && !taskId ? "true" : "false"}
                    aria-current={projectId === project.id && !taskId ? "page" : undefined}
                    onClick={(event) => navigateLink(event, () => onSelect(project.id))}>
                    <span className="sec-nav-label">{project.name}</span>
                    <span className="sec-nav-count">{work.filter((task) => task.status !== "done").length}</span>
                  </a>
                </div>
                {open ? <ul id={groupId} className="task-nav-group-list">
                  {work.map((task) => <li key={task.id}>
                    <a className="task-nav-task" href={projectTasksHref(project.id, task.id)}
                      aria-current={task.id === taskId ? "page" : undefined}
                      onClick={onOpenTask ? (event) => navigateLink(event, () => onOpenTask(task.id, project.id)) : undefined}>
                      <StateMark shape={TASK_STATUS_SHAPE[task.status]} />
                      <span>{task.title}</span>
                    </a>
                  </li>)}
                  {!work.length ? <li className="task-nav-empty">{t("project.no_tasks")}</li> : null}
                </ul> : null}
              </section>
            );
          })}
        </nav>
      </div>
      <label className="task-project-nav-mobile">
        <span className="sr-only">{t("project.projects")}</span>
        <select value={projectId ?? ""} onChange={(event) => onSelect(event.target.value || null)}>
          <option value="">{t("project.all_projects")}</option>
          {visible.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
        </select>
      </label>
      {status === "loading" ? <p role="status">{t("project.loading")}</p> : null}
      {status === "error" ? <div role="alert"><p>{t("project.load_failed")}</p><Button variant="ghost" onClick={onRetry}>{t("project.retry")}</Button></div> : null}
      <Button className="task-project-nav-create" variant="ghost" onClick={onCreate}>
        <ActionAdd size={ICON.sm} />{t("project.create")}
      </Button>
    </aside>
  );
}
