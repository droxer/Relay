"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { listTaskWorkspaceFiles, readTaskWorkspaceFile, taskWorkspaceStatus } from "../../api";
import type {
  TaskWorkspaceFileResponse,
  TaskWorkspaceFilesResponse,
} from "../../types";
import {
  WorkspaceFileList,
  WorkspacePathBreadcrumb,
} from "../workspace/WorkspaceFileList";
import { WorkspaceFilePreview } from "../workspace/WorkspaceFilePreview";
import { languageForFile } from "../CodeView";
import { ICON, NavBack } from "../icons";
import { Button } from "@/components/ui/button";
import { taskWorkspaceState } from "./taskWorkspaceState";

/** The directory this task's rounds share, browsed inside the task drawer.
 *
 *  Live reads only: the workspace exists on the computer that ran the task, so
 *  an offline Computer is distinct from an empty or not-yet-created directory.
 *  The artifact list above stays the durable record either way.
 *
 *  A routine lists its occurrence directories; the routine itself never runs. */
export function TaskDrawerWorkspace({ taskId, onOpenThread }: { taskId: string; onOpenThread?: (sessionId: string) => void }) {
  const { t } = useTranslation();
  const [path, setPath] = useState("");
  const [selectedPath, setSelectedPath] = useState("");
  const selectedName = selectedPath ? selectedPath.split("/").at(-1) || selectedPath : "";

  const fileQuery = useQuery({
    queryKey: ["workspace-files", `task:${taskId}`, path, 0],
    retry: false,
    queryFn: ({ signal }): Promise<TaskWorkspaceFilesResponse> =>
      listTaskWorkspaceFiles({ taskId, path }, signal),
  });
  const contentQuery = useQuery({
    queryKey: ["workspace-file", `task:${taskId}`, selectedPath, 0],
    enabled: Boolean(selectedPath),
    retry: false,
    queryFn: ({ signal }): Promise<TaskWorkspaceFileResponse> =>
      readTaskWorkspaceFile({ taskId, path: selectedPath }, signal),
  });

  const statusQuery = useQuery({
    queryKey: ["task-workspace-status", taskId],
    queryFn: ({ signal }) => taskWorkspaceStatus(taskId, signal),
    refetchInterval: 3000,
    retry: false,
  });

  function openDirectory(next: string): void {
    setPath(next);
    setSelectedPath("");
  }

  const state = taskWorkspaceState({
    isLoading: fileQuery.isLoading,
    error: fileQuery.error,
    data: fileQuery.data,
    path,
  });

  return (
    <section className="task-drawer-artifacts" aria-label={t("backlog.workspace")}>
      <h3 className="task-drawer-artifacts-title">{t("backlog.workspace")}</h3>
      <Button variant="ghost" type="button" onClick={() => {
        void fileQuery.refetch();
        if (selectedPath) void contentQuery.refetch();
      }}>{t("backlog.workspace_refresh")}</Button>
      {statusQuery.data?.waiting ? (
        <p className="task-drawer-artifacts-empty" role="status">
          {t("backlog.workspace_waiting")}{" "}
          {statusQuery.data.blockingSessionId ? (
            <a href={`/threads/${encodeURIComponent(statusQuery.data.blockingSessionId)}`} onClick={event => {
              if (onOpenThread && statusQuery.data?.blockingSessionId) {
                event.preventDefault();
                onOpenThread(statusQuery.data.blockingSessionId);
              }
            }}>{statusQuery.data.blockingTitle || t("backlog.workspace_open_active")}</a>
          ) : null}
        </p>
      ) : null}
      {fileQuery.data?.sharedWithProject ? (
        <p className="task-drawer-artifacts-empty">{t("backlog.workspace_shared_project")}</p>
      ) : null}
      {["not-created", "offline", "unsupported", "denied"].includes(state) ? (
        <p className="task-drawer-artifacts-empty" role="status">
          {t(`backlog.workspace_${state.replace("-", "_")}`)}
        </p>
      ) : state === "loading" ? (
        <p className="task-drawer-artifacts-empty" role="status" aria-live="polite">
          {t("backlog.workspace_loading")}
        </p>
      ) : state === "unavailable" ? (
        <p className="task-drawer-artifacts-empty">{t("backlog.workspace_unavailable")}</p>
      ) : state === "failed" ? (
        <p className="task-drawer-artifacts-empty" role="alert">
          {t("backlog.workspace_error")}
        </p>
      ) : state === "empty" ? (
        <p className="task-drawer-artifacts-empty">{t("backlog.workspace_empty")}</p>
      ) : selectedPath ? (
        <div className="thread-space-files">
          <div className="thread-space-files-bar">
            <Button
              variant="ghost"
              type="button"
              className="thread-space-back"
              onClick={() => setSelectedPath("")}
            >
              <NavBack size={ICON.sm} />
              <span>{selectedName}</span>
            </Button>
            <span className="workspace-preview-file-type code">{languageForFile(selectedName)}</span>
          </div>
          <div className="thread-space-files-body">
            <WorkspaceFilePreview
              name={selectedName}
              data={contentQuery.data}
              isLoading={contentQuery.isLoading}
              error={contentQuery.isError ? contentQuery.error : null}
            />
          </div>
        </div>
      ) : (
        <div className="thread-space-files">
          <div className="thread-space-files-bar">
            <WorkspacePathBreadcrumb path={path} onNavigate={openDirectory} />
          </div>
          <div className="thread-space-files-body">
            <WorkspaceFileList
              data={fileQuery.data}
              error={fileQuery.error}
              isLoading={fileQuery.isLoading}
              path={path}
              selectedPath={selectedPath}
              onOpenDirectory={openDirectory}
              onSelectFile={(entry) => setSelectedPath(entry.path)}
              onRetry={() => void fileQuery.refetch()}
            />
          </div>
        </div>
      )}
    </section>
  );
}
