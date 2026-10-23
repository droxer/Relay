"use client";

import { memo, useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { IssuesPage } from "./IssuesPage";
import { ProjectDrawer } from "./ProjectDrawer";
import { Button } from "@/components/ui/button";
import type { ProjectCollectionStatus } from "../lib/projectPage";
import type { CurrentUser, DaemonNodeMonitorRecord, ProjectRecord, RelayTaskListItem } from "../types";

/**
 * The global Issues route. A project's own board lives on its Tasks tab;
 * `?project=` here is only a filter on the cross-project table.
 */
function TasksWorkspaceView({ projects, projectsStatus, tasks, nodes,
  currentUser, recordTaskId, onOpenRecord, onOpenThread, isRefreshing, onRefresh }: {
  projects: ProjectRecord[];
  projectsStatus: ProjectCollectionStatus;
  tasks: RelayTaskListItem[];
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
  // Held by value so the memoized board sees the same notice and handler
  // until the project fetch actually changes state.
  const projectNotice = useMemo(() => (projectsStatus !== "ready" ? (
    <div className="task-project-notice" role={projectsStatus === "error" ? "alert" : "status"}>
      <span>{t(projectsStatus === "error" ? "project.load_failed" : "project.loading")}</span>
      {projectsStatus === "error" ? <Button variant="ghost" onClick={() => void onRefresh()}>{t("project.retry")}</Button> : null}
    </div>
  ) : undefined), [onRefresh, projectsStatus, t]);
  const openProjectDrawer = useCallback((onCreated: (id: string) => void) => setDrawer({ onCreated }), []);
  return (
    <div className="tasks-workspace">
      <div className="tasks-workspace-content">
        <IssuesPage
          tasks={tasks}
          projects={projects}
          projectNotice={projectNotice}
          onCreateProject={openProjectDrawer}
          nodes={nodes}
          currentUser={currentUser}
          recordTaskId={recordTaskId}
          onOpenRecord={onOpenRecord}
          onOpenThread={onOpenThread}
          isRefreshing={isRefreshing}
          onRefresh={onRefresh}
        />
      </div>
      <ProjectDrawer open={drawer !== null} computers={nodes} userId={currentUser.userId} layer={drawer?.onCreated ? (recordTaskId ? 2 : 1) : 0}
        onClose={() => setDrawer(null)} onSaved={(saved) => drawer?.onCreated?.(saved.id)} />
    </div>
  );
}

// Memoized with the board beneath it: the shell above re-renders per streamed frame.
export const TasksWorkspace = memo(TasksWorkspaceView);
