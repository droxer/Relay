"use client";

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { BacklogPage } from "./BacklogPage";
import { ProjectTaskNav } from "./ProjectTaskNav";
import { ProjectWorkspacePage } from "./ProjectWorkspacePage";
import { ProjectDrawer } from "./ProjectDrawer";
import { Button } from "@/components/ui/button";
import type { ProjectCollectionStatus } from "../lib/projectPage";
import type { AgentTeam, CurrentUser, DaemonNodeMonitorRecord, EmployeeAgent, ProjectRecord, RelaySession, RelayTaskListItem } from "../types";

export function TasksWorkspace({ projects, projectsStatus, projectId, tasks, sessions, nodes, agents, teams,
  currentUser, recordTaskId, onOpenRecord, onSelectProject, onOpenThread, isRefreshing, onRefresh }: {
  projects: ProjectRecord[];
  projectsStatus: ProjectCollectionStatus;
  projectId: string | null;
  tasks: RelayTaskListItem[];
  sessions: RelaySession[];
  nodes: DaemonNodeMonitorRecord[];
  agents: EmployeeAgent[];
  teams: AgentTeam[];
  currentUser: CurrentUser;
  recordTaskId: string | null;
  onOpenRecord: (id: string | null) => void;
  onSelectProject: (id: string | null) => void;
  onOpenThread: (id: string) => void;
  isRefreshing: boolean;
  onRefresh: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const [drawer, setDrawer] = useState<{ project: ProjectRecord | null; onCreated?: (id: string) => void } | null>(null);
  const project = projects.find((item) => item.id === projectId);
  const archivedIds = new Set(projects.filter((item) => item.archivedAt).map((item) => item.id));
  return (
    <div className="tasks-workspace">
      <ProjectTaskNav projects={projects} tasks={tasks} projectId={projectId}
        status={projectsStatus} onRetry={() => void onRefresh()}
        onSelect={onSelectProject} onCreate={() => setDrawer({ project: null })} />
      <div className="tasks-workspace-content">
        {projectId ? project ? (
          <ProjectWorkspacePage key={project.id} project={project} tasks={tasks} agents={agents} teams={teams}
            currentUser={currentUser} computers={nodes} onOpenThread={onOpenThread}
            onOpenSettings={() => setDrawer({ project })} onBack={() => onSelectProject(null)} />
        ) : (
          <section id="project-detail-panel" className="route-loading" tabIndex={-1}>
            <p role={projectsStatus === "error" ? "alert" : "status"}>
              {t(projectsStatus === "loading" ? "project.loading" : projectsStatus === "error" ? "project.load_failed" : "project.not_found")}
            </p>
            {projectsStatus === "error" ? <Button onClick={() => void onRefresh()}>{t("project.retry")}</Button> : null}
          </section>
        ) : (
          <BacklogPage tasks={tasks.filter((task) => !task.deletedAt && (!task.projectId || !archivedIds.has(task.projectId)))}
            projects={projects} onCreateProject={(onCreated) => setDrawer({ project: null, onCreated })}
            sessions={sessions} nodes={nodes} currentUser={currentUser} recordTaskId={recordTaskId}
            onOpenRecord={onOpenRecord} onOpenThread={onOpenThread} isRefreshing={isRefreshing} onRefresh={onRefresh} />
        )}
      </div>
      <ProjectDrawer open={drawer !== null} project={drawer?.project} computers={nodes}
        layer={drawer?.onCreated ? 1 : 0}
        onClose={() => setDrawer(null)} onSaved={(saved) => {
          if (drawer?.onCreated) drawer.onCreated(saved.id);
          else onSelectProject(saved.id);
        }} />
    </div>
  );
}
