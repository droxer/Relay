"use client";

import { useState } from "react";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { listTaskWorkspaceFiles, readTaskWorkspaceFile, taskWorkspaceStatus } from "../../api";
import type {
  RelayTask,
  RelayTaskSummary,
  TaskRunsResponse,
  TaskStatus,
  TaskWorkspaceFileResponse,
  TaskWorkspaceFilesResponse,
} from "../../types";
import { useWorkspaceFileView } from "../workspace/WorkspaceFilePreview";
import { WorkspaceFilePanes } from "../workspace/WorkspaceFilePanes";
import { Button } from "@/components/ui/button";
import { workspaceHomeStatus } from "../../lib/workspaceHome";
import { ICON, NavRefresh } from "../icons";
import { taskWorkspaceState } from "./taskWorkspaceState";
import { workspaceFileRoots, workspaceTabRootFor } from "../../lib/workspaceFileTabs";
import { TASK_RECORD_QUERY_KEY } from "../../hooks/useTaskRecord";
import { TASKS_QUERY_KEY } from "../../hooks/useRelayData";
import { taskWorkspaceStatusPollIntervalMs } from "../../lib/relayPolling";

/** The task's status as the cache already knows it: its record (the task
 *  drawer), its row in a routine's run ledger (the Runs tab), or the list. */
function cachedTaskStatus(queryClient: QueryClient, taskId: string): TaskStatus | undefined {
  const record = queryClient.getQueryData<RelayTask>([TASK_RECORD_QUERY_KEY, taskId]);
  if (record) return record.status;
  for (const [, runs] of queryClient.getQueriesData<TaskRunsResponse>({ queryKey: ["task-runs"] })) {
    const run = runs?.runs.find((candidate) => candidate.taskId === taskId);
    if (run) return run.status;
  }
  return queryClient.getQueryData<RelayTaskSummary[]>(TASKS_QUERY_KEY)?.find((task) => task.id === taskId)?.status;
}

/** The directory this task's rounds share, browsed inside the task drawer.
 *
 *  Live reads only: the workspace exists on the computer that ran the task, so
 *  an offline Computer is distinct from an empty or not-yet-created directory.
 *  The Artifacts tab stays the durable record either way.
 *
 *  A routine never runs, so it has no folder of its own to show here: the
 *  Runs tab mounts this once per selected run, rooted at that run's folder. */
export function RecordWorkspace({ taskId, artifactsDir, rootLabel }: {
  taskId: string;
  /** Where this task's deliverables live, relative to the workspace it
   *  browses: `artifacts`, one automation run's `artifacts/<taskId>`, or
   *  null for a project task, whose workspace is the deliverable location. */
  artifactsDir?: string | null;
  /** The path bar's root label — a run's date when browsed from the Runs tab. */
  rootLabel?: string;
}) {
  const { t } = useTranslation();
  const roots = workspaceFileRoots(artifactsDir);
  const [path, setPath] = useState(roots.artifacts);
  const [selectedPath, setSelectedPath] = useState("");

  const fileQuery = useQuery({
    queryKey: ["workspace-files", `task:${taskId}`, path, 0],
    retry: false,
    queryFn: ({ signal }): Promise<TaskWorkspaceFilesResponse> =>
      listTaskWorkspaceFiles({ taskId, path }, signal),
  });
  // A missing tab root says nothing about the workspace itself; its root
  // listing tells "no artifacts yet" from "never created".
  const atTabRoot = workspaceTabRootFor(path, roots) !== null;
  const rootQuery = useQuery({
    queryKey: ["workspace-files", `task:${taskId}`, "", 0],
    enabled: atTabRoot && fileQuery.data?.exists === false,
    retry: false,
    queryFn: ({ signal }): Promise<TaskWorkspaceFilesResponse> =>
      listTaskWorkspaceFiles({ taskId, path: "" }, signal),
  });
  const contentQuery = useQuery({
    queryKey: ["workspace-file", `task:${taskId}`, selectedPath, 0],
    enabled: Boolean(selectedPath),
    retry: false,
    queryFn: ({ signal }): Promise<TaskWorkspaceFileResponse> =>
      readTaskWorkspaceFile({ taskId, path: selectedPath }, signal),
  });
  const { view, setView } = useWorkspaceFileView(selectedPath);

  // Polled only while it can still change: while its note shows, or while
  // the task can still start work. Re-evaluated on every render, so the
  // parent re-rendering a retried task resumes it.
  const queryClient = useQueryClient();
  const statusQuery = useQuery({
    queryKey: ["task-workspace-status", taskId],
    queryFn: ({ signal }) => taskWorkspaceStatus(taskId, signal),
    refetchInterval: (query) => taskWorkspaceStatusPollIntervalMs({
      waiting: query.state.data?.waiting,
      taskStatus: cachedTaskStatus(queryClient, taskId),
    }),
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
    root: { isLoading: rootQuery.isLoading, error: rootQuery.error, data: rootQuery.data },
  });

  function refresh(): void {
    void fileQuery.refetch();
    if (rootQuery.data || rootQuery.error) void rootQuery.refetch();
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
            roots={roots}
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
