"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { listProjectWorkspaceFiles, readProjectWorkspaceFile } from "../../api";
import type {
  ProjectWorkspaceFileResponse,
  ProjectWorkspaceFilesResponse,
} from "../../types";
import {
  WorkspaceFileList,
  WorkspacePathBreadcrumb,
} from "../workspace/WorkspaceFileList";
import { PROJECT_WORKSPACE_FILE_ROOTS } from "../../lib/workspaceFileTabs";
import {
  WorkspaceFilePreview,
  useWorkspaceFileView,
} from "../workspace/WorkspaceFilePreview";
import { WorkspaceFileActions } from "../workspace/WorkspaceFileActions";
import { FilePaneBack } from "../workspace/FilePaneBack";
import { ICON, NavRefresh } from "../icons";
import { Button } from "@/components/ui/button";
import { OverlayCloseButton } from "@/components/ui/OverlayCloseButton";

/** The panel browses the project's files: the project directory is its
 *  deliverable location, so there is no `artifacts/` folder to scope to. The
 *  Activity switch (thread records under `.relay/threads/`) stays on the full project
 *  workspace page: in a few hundred pixels a second switch under the Project /
 *  This thread tabs was one level of chrome too many. */
const PANEL_ROOT = PROJECT_WORKSPACE_FILE_ROOTS.artifacts;

/** `path` relative to the panel root, "" at the root itself. */
function relativeToRoot(path: string): string {
  if (PANEL_ROOT === "") return path;
  return path.startsWith(`${PANEL_ROOT}/`) ? path.slice(PANEL_ROOT.length + 1) : "";
}

/** A panel-relative path back to a workspace path. */
function fromRoot(relative: string): string {
  if (!relative) return PANEL_ROOT;
  return PANEL_ROOT === "" ? relative : `${PANEL_ROOT}/${relative}`;
}

/** Refetches the project's listing and open file. Lives beside the browser so
 *  the panel header (which owns the button while the list is on screen) and
 *  the file bar share one query-key shape. */
export function useRefreshProjectFiles(projectId: string): () => void {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: ["workspace-files", `project:${projectId}`] });
    void queryClient.invalidateQueries({ queryKey: ["workspace-file", `project:${projectId}`] });
  };
}

/** The project workspace, browsed inside the thread output panel.
 *
 *  One column, not the page's two panes: the panel is a few hundred pixels
 *  wide, so opening a file replaces the listing and a back control returns
 *  to it — the same drill-down the artifact list already uses. At the root
 *  the list is the whole body (the panel header names it and holds refresh);
 *  a path bar appears only once you are inside a folder.
 *
 *  Selection is local state rather than `?path`/`?item` search params: those
 *  belong to the full project workspace page, and sharing them would make a
 *  file opened in the panel reopen there (and vice versa) on the next visit. */
export function ThreadSpaceFiles({
  projectId,
  selectedPath,
  onSelectPath,
  onClose,
}: {
  projectId: string;
  /** Owned by the panel: with a file open, the panel header stands down and
   *  this bar becomes the panel's only chrome row, which the panel cannot
   *  decide from state held down here. */
  selectedPath: string;
  onSelectPath: (path: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [path, setPath] = useState(PANEL_ROOT);
  const setSelectedPath = onSelectPath;
  const selectedName = selectedPath ? selectedPath.split("/").at(-1) || selectedPath : "";

  const fileQuery = useQuery({
    queryKey: ["workspace-files", `project:${projectId}`, path, 0],
    queryFn: ({ signal }): Promise<ProjectWorkspaceFilesResponse> =>
      listProjectWorkspaceFiles({ projectId, path }, signal),
  });
  const contentQuery = useQuery({
    queryKey: ["workspace-file", `project:${projectId}`, selectedPath, 0],
    enabled: Boolean(selectedPath),
    queryFn: ({ signal }): Promise<ProjectWorkspaceFileResponse> =>
      readProjectWorkspaceFile({ projectId, path: selectedPath }, signal),
  });
  const { view, setView } = useWorkspaceFileView(selectedPath);

  function openDirectory(next: string): void {
    setPath(next);
    setSelectedPath("");
  }

  /* An agent writes into this workspace while the reader watches it, and
     nothing here refetches on its own (window-focus refetch is off app-wide),
     so the listing and the open file would otherwise stay as first loaded. */
  const refresh = useRefreshProjectFiles(projectId);
  const subPath = relativeToRoot(path);

  if (selectedPath) {
    return (
      <div className="thread-space-files">
        <div className="thread-space-files-bar">
          <FilePaneBack onClick={() => setSelectedPath("")} />
          <span className="thread-space-files-name">{selectedName}</span>
          {/* Same row, same controls, same order as the full-page pane
              (ProjectWorkspaceFiles) — a file behaves identically wherever it
              is opened. The language chip that used to sit here only restated
              the extension already in the name beside it. Close sits outside
              the actions group so a narrow panel can keep it on the name's
              line while the actions wrap below (thread-space.css). */}
          <div className="thread-space-files-actions">
            <WorkspaceFileActions
              name={selectedName}
              data={contentQuery.data}
              view={view}
              onViewChange={setView}
            />
            <RefreshFilesButton onClick={refresh} />
          </div>
          <OverlayCloseButton
            className="overlay-close thread-space-files-close"
            label={t("sheet.close")}
            onClick={onClose}
          />
        </div>
        <div className="thread-space-files-body">
          <WorkspaceFilePreview
            name={selectedName}
            data={contentQuery.data}
            isLoading={contentQuery.isLoading}
            error={contentQuery.isError ? contentQuery.error : null}
            view={view}
            onRetry={() => void contentQuery.refetch()}
          />
        </div>
      </div>
    );
  }

  return (
    <div className={`thread-space-files${subPath ? "" : " is-root"}`}>
      {subPath ? (
        <div className="thread-space-files-bar is-path">
          <WorkspacePathBreadcrumb
            path={subPath}
            rootLabel={t("workspace.tab_files")}
            onNavigate={(next) => openDirectory(fromRoot(next))}
          />
        </div>
      ) : null}
      <div className="thread-space-files-body" aria-label={t("workspace.tab_files")}>
        <WorkspaceFileList
          data={fileQuery.data}
          error={fileQuery.error}
          isLoading={fileQuery.isLoading}
          path={path}
          roots={PROJECT_WORKSPACE_FILE_ROOTS}
          rootPath={PANEL_ROOT}
          selectedPath={selectedPath}
          onOpenDirectory={openDirectory}
          onSelectFile={(entry) => setSelectedPath(entry.path)}
          onRetry={() => void fileQuery.refetch()}
        />
      </div>
    </div>
  );
}

export function RefreshFilesButton({ onClick }: { onClick: () => void }) {
  const { t } = useTranslation();
  return (
    <Button
      variant="ghost"
      size="icon-dense"
      type="button"
      tooltip={t("workspace.refresh_files")}
      aria-label={t("workspace.refresh_files")}
      onClick={onClick}
    >
      <NavRefresh size={ICON.sm} aria-hidden="true" />
    </Button>
  );
}
