"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { listTaskWorkspaceFiles, readTaskWorkspaceFile, taskWorkspaceStatus } from "../../api";
import type {
  TaskWorkspaceFileResponse,
  TaskWorkspaceFilesResponse,
} from "../../types";
import { useWorkspaceFileView } from "../workspace/WorkspaceFilePreview";
import { WorkspaceFilePanes } from "../workspace/WorkspaceFilePanes";
import { Button } from "@/components/ui/button";
import { workspaceHomeStatus } from "../../lib/workspaceHome";
import { ICON, NavRefresh } from "../icons";
import { taskWorkspaceState } from "./taskWorkspaceState";

/** The directory this task's rounds share, browsed inside the task drawer.
 *
 *  Live reads only: the workspace exists on the computer that ran the task, so
 *  an offline Computer is distinct from an empty or not-yet-created directory.
 *  The Artifacts tab stays the durable record either way.
 *
 *  A routine never runs, so it has no folder of its own to show here: the
 *  Runs tab mounts this once per selected run, rooted at that run's folder. */
export function RecordWorkspace({ taskId, rootLabel }: {
  taskId: string;
  /** The path bar's root label — a run's date when browsed from the Runs tab. */
  rootLabel?: string;
}) {
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
  const { view, setView } = useWorkspaceFileView(selectedName);

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

  function refresh(): void {
    void fileQuery.refetch();
    if (selectedPath) void contentQuery.refetch();
  }

  /* The project's explorer, not a boxed copy of it: the path bar heads the
     listing (so there is no second "Workspace" title over it), the live
     source sits at the bar's end, and refresh joins it there. */
  const refreshButton = (
    <Button
      variant="ghost"
      size="icon-dense"
      className="record-workspace-refresh"
      type="button"
      tooltip={t("backlog.workspace_refresh")}
      aria-label={t("backlog.workspace_refresh")}
      onClick={refresh}
    >
      <NavRefresh size={ICON.sm} aria-hidden="true" />
    </Button>
  );

  const notice = ["not-created", "offline", "unsupported", "denied"].includes(state) ? (
    <p className="record-panel-note" role="status">
      {t(`backlog.workspace_${state.replace("-", "_")}`)}
    </p>
  ) : state === "loading" ? (
    <p className="record-panel-note" role="status" aria-live="polite">
      {t("backlog.workspace_loading")}
    </p>
  ) : state === "unavailable" ? (
    <p className="record-panel-note">{t("backlog.workspace_unavailable")}</p>
  ) : state === "failed" ? (
    <p className="record-panel-note" role="alert">
      {t("backlog.workspace_error")}
    </p>
  ) : state === "empty" ? (
    <p className="record-panel-note">{t("backlog.workspace_empty")}</p>
  ) : null;

  return (
    <section className="record-workspace" aria-label={t("backlog.workspace")}>
      {/* Why this listing is stale, named but not linked: the recovery panel at
          the top of the drawer owns navigation to the blocking thread, and one
          drawer should not offer the same thread twice. */}
      {statusQuery.data?.waiting ? (
        <p className="record-panel-note record-workspace-note" role="status">
          {t("backlog.workspace_waiting")}
          {statusQuery.data.blockingTitle ? ` ${statusQuery.data.blockingTitle}` : ""}
        </p>
      ) : null}
      {fileQuery.data?.sharedWithProject ? (
        <p className="record-panel-note record-workspace-note">{t("backlog.workspace_shared_project")}</p>
      ) : null}
      {notice ? (
        <div className="record-workspace-notice">
          {notice}
          {refreshButton}
        </div>
      ) : (
        <div className="record-workspace-files">
          <WorkspaceFilePanes
            path={path}
            rootLabel={rootLabel}
            selectedPath={selectedPath}
            files={{ data: fileQuery.data, error: fileQuery.error, isLoading: fileQuery.isLoading }}
            content={{ data: contentQuery.data, error: contentQuery.error, isLoading: contentQuery.isLoading }}
            view={view}
            setView={setView}
            homeStatus={workspaceHomeStatus(fileQuery.data)}
            barActions={refreshButton}
            openDirectory={openDirectory}
            onSelectFile={(entry) => setSelectedPath(entry.path)}
            onRetry={() => void fileQuery.refetch()}
            onClosePreview={() => setSelectedPath("")}
          />
        </div>
      )}
    </section>
  );
}
