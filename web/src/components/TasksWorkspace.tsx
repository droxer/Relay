"use client";

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { BacklogPage } from "./BacklogPage";
import { ProjectDrawer } from "./ProjectDrawer";
import { Button } from "@/components/ui/button";
import { useUrlSearchState } from "../hooks/useUrlSearchState";
import type { ProjectCollectionStatus } from "../lib/projectPage";
import type { CurrentUser, DaemonNodeMonitorRecord, ProjectRecord, RelaySession, RelayTaskListItem } from "../types";

export function TasksWorkspace({ projects, projectsStatus, tasks, sessions, nodes,
  currentUser, recordTaskId, onOpenRecord, onOpenThread, isRefreshing, onRefresh }: {
  projects: ProjectRecord[];
  projectsStatus: ProjectCollectionStatus;
  tasks: RelayTaskListItem[];
  sessions: RelaySession[];
  nodes: DaemonNodeMonitorRecord[];
  currentUser: CurrentUser;
  recordTaskId: string | null;
  onOpenRecord: (id: string | null) => void;
  onOpenThread: (id: string, taskId?: string) => void;
  isRefreshing: boolean;
  onRefresh: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const [scope, setScope] = useUrlSearchState<string | null>("project", null, (value) => value || null, (value) => value);
  const projectId = scope;
  const [drawer, setDrawer] = useState<{ onCreated?: (id: string) => void } | null>(null);
  const project = projects.find((item) => item.id === projectId);
  const archivedIds = new Set(projects.filter((item) => item.archivedAt).map((item) => item.id));
  const selectProject = (id: string | null) => { setScope(id); };
  const scopedTasks = tasks.filter((task) => !task.deletedAt && (projectId
    ? task.projectId === projectId
    : !task.projectId || !archivedIds.has(task.projectId)));
  return (
    <div className="tasks-workspace">
      <div className="tasks-workspace-content">
        {projectId && !project && !recordTaskId ? (
          <section id="backlog-panel" className="route-loading" tabIndex={-1}>
            <p role={projectsStatus === "error" ? "alert" : "status"}>
              {t(projectsStatus === "loading" ? "project.loading" : projectsStatus === "error" ? "project.load_failed" : "project.not_found")}
            </p>
            <Button variant="ghost" onClick={() => selectProject(null)}>{t("project.all_projects")}</Button>
            {projectsStatus === "error" ? <Button onClick={() => void onRefresh()}>{t("project.retry")}</Button> : null}
          </section>
        ) : (
          <BacklogPage key={projectId ?? "all"} tasks={scopedTasks} projectId={projectId ?? undefined} onSelectProject={selectProject}
            projectNotice={projectsStatus !== "ready" ? <div className="task-project-notice" role={projectsStatus === "error" ? "alert" : "status"}>
              <span>{t(projectsStatus === "error" ? "project.load_failed" : "project.loading")}</span>
              {projectsStatus === "error" ? <Button variant="ghost" onClick={() => void onRefresh()}>{t("project.retry")}</Button> : null}
            </div> : undefined}
            projects={projects} onCreateProject={(onCreated) => setDrawer({ onCreated })}
            sessions={sessions} nodes={nodes} currentUser={currentUser} recordTaskId={recordTaskId}
            onOpenRecord={onOpenRecord} onOpenThread={onOpenThread} isRefreshing={isRefreshing} onRefresh={onRefresh} />
        )}
      </div>
      <ProjectDrawer open={drawer !== null} computers={nodes} layer={drawer?.onCreated ? (recordTaskId ? 2 : 1) : 0}
        onClose={() => setDrawer(null)} onSaved={(saved) => {
          if (drawer?.onCreated) drawer.onCreated(saved.id);
          else selectProject(saved.id);
        }} />
    </div>
  );
}
