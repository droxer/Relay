"use client";

import { useTranslation } from "react-i18next";
import { SectionNav } from "./SectionNav";
import { Button } from "@/components/ui/button";
import { ActionAdd, ICON, NavProjects } from "./icons";
import type { ProjectRecord, RelayTaskListItem } from "../types";
import type { ProjectCollectionStatus } from "../lib/projectPage";

export function ProjectTaskNav({ projects, tasks, projectId, onSelect, onCreate, status, onRetry }: {
  projects: ProjectRecord[];
  tasks: RelayTaskListItem[];
  projectId: string | null;
  onSelect: (id: string | null) => void;
  onCreate: () => void;
  status: ProjectCollectionStatus;
  onRetry: () => void;
}) {
  const { t } = useTranslation();
  const visible = projects.filter((project) => !project.archivedAt || project.id === projectId);
  const counts = new Map<string, number>();
  for (const task of tasks) {
    if (task.projectId && !task.deletedAt && !task.isRoutine && task.status !== "done") {
      counts.set(task.projectId, (counts.get(task.projectId) ?? 0) + 1);
    }
  }
  const items = [
    { id: "", label: t("project.all_projects"), href: "/backlog", Icon: NavProjects },
    ...visible.map((project) => ({
      id: project.id, label: project.name, count: counts.get(project.id) ?? 0,
      href: `/projects/${encodeURIComponent(project.id)}`,
    })),
  ];
  return (
    <aside className="task-project-nav" aria-label={t("project.projects")}>
      <div className="task-project-nav-desktop">
        <h2 className="task-project-nav-title">{t("project.projects")}</h2>
        <SectionNav items={items} value={projectId ?? ""} onChange={(id) => onSelect(id || null)} label={t("project.projects")} />
      </div>
      <label className="task-project-nav-mobile">
        <span className="sr-only">{t("project.projects")}</span>
        <select value={projectId ?? ""} onChange={(event) => onSelect(event.target.value || null)}>
          {items.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
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
