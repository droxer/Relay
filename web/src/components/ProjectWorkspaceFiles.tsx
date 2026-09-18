"use client";

import { type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { StateMark } from "./StateMark";
import {
  listProjectWorkspaceFiles,
  readProjectWorkspaceFile,
} from "../api";
import type {
  ProjectWorkspaceFileResponse,
  ProjectWorkspaceFilesResponse,
} from "../types";
import { workspaceHomeStatus } from "../lib/workspaceHome";
import {
  ActionRemove,
  ICON,
} from "./icons";
import { Button } from "@/components/ui/button";
import { useUrlSearchState } from "../hooks/useUrlSearchState";
import {
  WorkspaceFileList,
  WorkspacePathBreadcrumb,
} from "./workspace/WorkspaceFileList";
import {
  WorkspaceFilePreview,
  useWorkspaceFileView,
} from "./workspace/WorkspaceFilePreview";
import { WorkspaceFileActions } from "./workspace/WorkspaceFileActions";

type FileSelection = { path: string; name: string };

const parseString = (value: string | null): string => value ?? "";

function PaneHeader({
  title,
  count,
  meta,
  actions,
}: {
  title: string;
  count?: number;
  meta?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="workspace-pane-head">
      <h2>{title}</h2>
      {count !== undefined ? <span className="tnum">{count}</span> : null}
      {meta ?? null}
      {actions ? <div className="workspace-pane-head-actions">{actions}</div> : null}
    </header>
  );
}

/** Persistent shared project root; available before the first conversation exists. */
export function ProjectWorkspaceFiles({
  projectId,
  refreshVersion = 0,
}: {
  projectId: string;
  refreshVersion?: number;
}) {
  return (
    <WorkspaceFileBrowser
      projectId={projectId}
      refreshVersion={refreshVersion}
    />
  );
}

function WorkspaceFileBrowser({
  projectId,
  refreshVersion,
}: {
  projectId: string;
  refreshVersion: number;
}) {
  const { t } = useTranslation();
  const [filePath, setFilePath] = useUrlSearchState("path", "", parseString, (value) => value || null);
  const [selectedKey, setSelectedKey] = useUrlSearchState("item", "", parseString, (value) => value || null);
  const selectedPath = selectedKey.startsWith("file:") ? selectedKey.slice(5) : "";
  const selected: FileSelection | null = selectedPath
    ? { path: selectedPath, name: selectedPath.split("/").at(-1) || selectedPath }
    : null;
  const fileQuery = useQuery({
    queryKey: ["workspace-files", `project:${projectId}`, filePath, refreshVersion],
    queryFn: ({ signal }): Promise<ProjectWorkspaceFilesResponse> =>
      listProjectWorkspaceFiles({ projectId, path: filePath }, signal),
  });
  const contentQuery = useQuery({
    queryKey: ["workspace-file", `project:${projectId}`, selectedPath, refreshVersion],
    enabled: Boolean(selectedPath),
    queryFn: ({ signal }): Promise<ProjectWorkspaceFileResponse> =>
      readProjectWorkspaceFile({ projectId, path: selectedPath }, signal),
  });
  const homeStatus = workspaceHomeStatus(fileQuery.data);
  const { view, setView } = useWorkspaceFileView(selected?.name ?? "");

  function openDirectory(path: string): void {
    setFilePath(path);
    setSelectedKey("");
  }

  return (
    <div className={`workspace-panes${selected ? "" : " is-browse-only"}`}>
      <section className="workspace-pane workspace-pane-browse" aria-label={t("workspace.tab_files")}>
        <div className="workspace-tabpanel-files">
          <div className="workspace-files-bar">
            <WorkspacePathBreadcrumb path={filePath} onNavigate={openDirectory} />
            <div className="workspace-files-bar-end">
              {homeStatus.kind === "live" ? (
                <span className="workspace-home-status" title={homeStatus.nodeId || undefined}>
                  <StateMark tone="good" />
                  {t("workspace.source_live")}
                  {homeStatus.nodeId ? <span className="workspace-home-node code">{homeStatus.nodeId}</span> : null}
                </span>
              ) : null}
            </div>
          </div>
          <WorkspaceFileList
            data={fileQuery.data}
            error={fileQuery.error}
            isLoading={fileQuery.isLoading}
            path={filePath}
            selectedPath={selectedPath}
            onOpenDirectory={openDirectory}
            onSelectFile={(entry) => setSelectedKey(`file:${entry.path}`)}
            onRetry={() => void fileQuery.refetch()}
          />
        </div>
      </section>

      {selected ? (
        <section className="workspace-pane workspace-pane-preview" aria-label={t("workspace.preview")}>
          {/* The name is the subject and the actions act on it, so they share
              one row — the language chip that used to sit here only restated
              the extension already in the name. */}
          <PaneHeader
            title={selected.name}
            actions={(
              <>
                <WorkspaceFileActions
                  name={selected.name}
                  data={contentQuery.data}
                  view={view}
                  onViewChange={setView}
                />
                <Button
                  variant="ghost"
                  type="button"
                  size="icon"
                  className="workspace-preview-close"
                  tooltip={t("workspace.close_preview")}
                  onClick={() => setSelectedKey("")}
                >
                  <ActionRemove size={ICON.sm} aria-hidden="true" />
                </Button>
              </>
            )}
          />
          <div className="workspace-pane-body workspace-preview-body">
            <WorkspaceFilePreview
              name={selected.name}
              data={contentQuery.data}
              isLoading={contentQuery.isLoading}
              error={contentQuery.isError ? contentQuery.error : null}
              view={view}
            />
          </div>
        </section>
      ) : null}
    </div>
  );
}
