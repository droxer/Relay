"use client";

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { IssuesPage } from "./IssuesPage";
import { ProjectDrawer } from "./ProjectDrawer";
import { Button } from "@/components/ui/button";
import type { ProjectCollectionStatus } from "../lib/projectPage";
import type { CurrentUser, DaemonNodeMonitorRecord, ProjectRecord, RelaySession, RelayTaskListItem } from "../types";

/**
 * The global Issues route. A project's own board lives on its Tasks tab;
 * `?project=` here is only a filter on the cross-project table.
 */
export function TasksWorkspace({ projects, projectsStatus, tasks, nodes,
  currentUser, recordTaskId, onOpenRecord, onOpenThread, isRefreshing, onRefresh }: {
  projects: ProjectRecord[];
  projectsStatus: ProjectCollectionStatus;
  tasks: RelayTaskListItem[];
  /** Accepted for the shell's call site; the table reads no thread state. */
  sessions?: RelaySession[];
  nodes: DaemonNodeMonitorRecord[];
  currentUser: CurrentUser;
  recordTaskId: string | null;
  onOpenRecord: (id: string | null) => void;
  onOpenThread: (id: string, taskId?: string) => void;
  isRefreshing: boolean;
  onRefresh: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const [drawer, setDrawer] = useState<{ onCreated?: (id: string) => void } | null>(null);
  const projectNotice = projectsStatus !== "ready" ? (
    <div className="task-project-notice" role={projectsStatus === "error" ? "alert" : "status"}>
      <span>{t(projectsStatus === "error" ? "project.load_failed" : "project.loading")}</span>
      {projectsStatus === "error" ? <Button variant="ghost" onClick={() => void onRefresh()}>{t("project.retry")}</Button> : null}
    </div>
  ) : undefined;
  return (
    <div className="tasks-workspace">
      <div className="tasks-workspace-content">
        <IssuesPage
          tasks={tasks}
          projects={projects}
          projectNotice={projectNotice}
          onCreateProject={(onCreated) => setDrawer({ onCreated })}
          nodes={nodes}
          currentUser={currentUser}
          recordTaskId={recordTaskId}
          onOpenRecord={onOpenRecord}
          onOpenThread={onOpenThread}
          isRefreshing={isRefreshing}
          onRefresh={onRefresh}
        />
      </div>
      <ProjectDrawer open={drawer !== null} computers={nodes} layer={drawer?.onCreated ? (recordTaskId ? 2 : 1) : 0}
        onClose={() => setDrawer(null)} onSaved={(saved) => drawer?.onCreated?.(saved.id)} />
    </div>
  );
}
