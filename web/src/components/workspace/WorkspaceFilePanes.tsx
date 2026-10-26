"use client";

import type { ComponentProps, ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { StateMark } from "../StateMark";
import { ActionRemove, ICON } from "../icons";
import { Button } from "@/components/ui/button";
import { WorkspaceFileList, WorkspacePathBreadcrumb } from "./WorkspaceFileList";
import { WorkspaceFilePreview } from "./WorkspaceFilePreview";
import { WorkspaceFileActions } from "./WorkspaceFileActions";
import { WorkspaceFileTabs } from "./WorkspaceFileTabs";
import {
  DEFAULT_WORKSPACE_FILE_ROOTS,
  olderThreadRecordsRoot,
  type WorkspaceFileRoots,
  workspaceFileTabForPath,
} from "../../lib/workspaceFileTabs";
import type { workspaceHomeStatus } from "../../lib/workspaceHome";

function PaneHeader({
  title,
  actions,
}: {
  title: string;
  actions?: ReactNode;
}) {
  return (
    <header className="workspace-pane-head">
      <h2>{title}</h2>
      {actions ? <div className="workspace-pane-head-actions">{actions}</div> : null}
    </header>
  );
}

export function WorkspaceFilePanes({
  path, roots = DEFAULT_WORKSPACE_FILE_ROOTS, rootLabel, scoped = false, selectedPath, files, content, view, setView, homeStatus, barActions,
  openDirectory, onSelectFile, onRetry, onClosePreview,
}: {
  path: string;
  /** Where this workspace keeps deliverables and thread records. */
  roots?: WorkspaceFileRoots;
  /** Replaces "home" at the root of the path bar. */
  rootLabel?: string;
  /** Hold the browser inside the current tab's root: no parent row above it,
   *  and the path bar starts there under `rootLabel`. */
  scoped?: boolean;
  selectedPath: string;
  files: Pick<ComponentProps<typeof WorkspaceFileList>, "data" | "error" | "isLoading">;
  content: Pick<ComponentProps<typeof WorkspaceFilePreview>, "data" | "error" | "isLoading">;
  view: ComponentProps<typeof WorkspaceFileActions>["view"];
  setView: ComponentProps<typeof WorkspaceFileActions>["onViewChange"];
  homeStatus?: ReturnType<typeof workspaceHomeStatus>;
  /** Surface-specific controls at the path bar's end, after the live source. */
  barActions?: ReactNode;
  openDirectory: (path: string) => void;
  onSelectFile: ComponentProps<typeof WorkspaceFileList>["onSelectFile"];
  onRetry: () => void;
  onClosePreview: () => void;
}) {
  const { t } = useTranslation();
  const selected = selectedPath ? { name: selectedPath.split("/").at(-1) || selectedPath } : null;
  const tab = workspaceFileTabForPath(path, roots);
  const activityRoot = olderThreadRecordsRoot(path) ?? roots.activities;
  const scopeRoot = scoped && tab ? (tab === "activities" ? activityRoot : roots.artifacts) : undefined;
  return (
    <div className={`workspace-panes${selected ? "" : " is-browse-only"}`}>
      <section className="workspace-pane workspace-pane-browse" aria-label={t("workspace.tab_files")}>
        <div className="workspace-tabpanel-files">
          <WorkspaceFileTabs
            tab={tab}
            projectFiles={roots.artifacts === ""}
            onSelect={(tab) => openDirectory(roots[tab])}
          />
          <div className="workspace-files-bar">
            <WorkspacePathBreadcrumb path={path} rootLabel={rootLabel} rootPath={scopeRoot} onNavigate={openDirectory} />
            <div className="workspace-files-bar-end">
              {homeStatus?.kind === "live" ? (
                <span className="workspace-home-status" title={homeStatus.nodeId || undefined}>
                  <StateMark tone="good" />
                  {t("workspace.source_live")}
                  {homeStatus.nodeId ? <span className="workspace-home-node code">{homeStatus.nodeId}</span> : null}
                </span>
              ) : null}
              {barActions}
            </div>
          </div>
          <WorkspaceFileList
            data={files.data}
            error={files.error}
            isLoading={files.isLoading}
            path={path}
            roots={roots}
            rootPath={scopeRoot}
            selectedPath={selectedPath}
            onOpenDirectory={openDirectory}
            onSelectFile={onSelectFile}
            onRetry={onRetry}
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
                  data={content.data}
                  view={view}
                  onViewChange={setView}
                />
                <Button
                  variant="ghost"
                  type="button"
                  size="icon"
                  className="workspace-preview-close"
                  tooltip={t("workspace.close_preview")}
                  aria-label={t("workspace.close_preview")}
                  onClick={onClosePreview}
                >
                  <ActionRemove size={ICON.sm} aria-hidden="true" />
                </Button>
              </>
            )}
          />
          <div className="workspace-pane-body workspace-preview-body">
            <WorkspaceFilePreview
              name={selected.name}
              data={content.data}
              isLoading={content.isLoading}
              error={content.error}
              view={view}
            />
          </div>
        </section>
      ) : null}
    </div>
  );
}
