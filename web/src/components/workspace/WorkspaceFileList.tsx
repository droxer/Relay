"use client";

import { useTranslation } from "react-i18next";
import type { ProjectWorkspaceFilesResponse, WorkspaceFileEntry } from "../../types";
import { isWorkspaceRetryableError } from "../../lib/workspaceHome";
import { compactDate, formatBytes, parentPath } from "../../lib/workspaceFormat";
import { ICON, WorkspaceFile, WorkspaceFolder } from "../icons";
import { WorkspaceEmpty, WorkspaceLoading } from "./WorkspacePrimitives";
import { Button } from "@/components/ui/button";

/** Every workspace-listing response (project, node, task, …) shares this
 *  shape apart from which id field names the owner — the list never reads
 *  that field, so it accepts any response minus its owner id. */
type WorkspaceFilesResponseLike = Omit<ProjectWorkspaceFilesResponse, "projectId">;

/* The workspace directory listing, shared by every surface that browses a
   project root: the full-page workspace tab and the thread output panel.
   Extracted so the two never drift into two different file rows. */

export function WorkspacePathBreadcrumb({
  path,
  onNavigate,
}: {
  path: string;
  onNavigate: (path: string) => void;
}) {
  const { t } = useTranslation();
  const parts = path.split("/").filter(Boolean);
  const segments = [{ label: t("workspace.path_root"), path: "" }, ...parts.map((part, index) => ({
    label: part,
    path: parts.slice(0, index + 1).join("/"),
  }))];

  return (
    <nav aria-label={t("workspace.path_label")}>
      <ol className="workspace-path-crumb">
        {segments.map((segment, index) => {
          const isCurrent = index === segments.length - 1;
          return (
            <li key={segment.path || "root"}>
              {index > 0 ? <span className="workspace-path-sep" aria-hidden="true">/</span> : null}
              {isCurrent ? (
                <span className="workspace-path-segment is-current code" title={segment.path}>{segment.label}</span>
              ) : (
                <Button
                  variant="ghost"
                  type="button"
                  className="workspace-path-segment code"
                  tooltip={segment.path}
                  aria-label={segment.label}
                  onClick={() => onNavigate(segment.path)}
                >
                  {segment.label}
                </Button>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

export function WorkspaceFileList({
  data,
  error,
  isLoading,
  path,
  selectedPath,
  onOpenDirectory,
  onSelectFile,
  onRetry,
}: {
  data?: WorkspaceFilesResponseLike;
  error: unknown;
  isLoading: boolean;
  path: string;
  selectedPath: string;
  onOpenDirectory: (path: string) => void;
  onSelectFile: (entry: WorkspaceFileEntry) => void;
  onRetry: () => void;
}) {
  const { t } = useTranslation();
  const entries = data?.entries ?? [];
  const sharedUnavailable = isWorkspaceRetryableError(error);
  const message = sharedUnavailable
    ? t("workspace.shared_unavailable")
    : error instanceof Error ? error.message : error ? String(error) : "";

  return (
    <div className="workspace-pane-body">
      {path ? (
        <Button variant="ghost" type="button" className="workspace-file-up h-auto justify-start rounded-none" onClick={() => onOpenDirectory(parentPath(path))}>
          {t("workspace.parent_directory")}
        </Button>
      ) : null}

      {isLoading ? (
        <WorkspaceLoading label={t("workspace.loading_files")} />
      ) : message ? (
        <div className="workspace-file-error">
          <WorkspaceEmpty title={message} mark={<WorkspaceFile size={ICON.lg} />} announce />
          {sharedUnavailable ? <Button type="button" variant="outline" size="dense" onClick={onRetry}>{t("workspace.retry")}</Button> : null}
        </div>
      ) : data && !data.exists ? (
        <WorkspaceEmpty title={t("workspace.files_unavailable")} mark={<WorkspaceFile size={ICON.lg} />} announce />
      ) : entries.length ? (
        <ul className="workspace-pick-list">
          {entries.map((entry) => (
            <li key={entry.path}>
              <WorkspaceFileRow
                entry={entry}
                selected={selectedPath === entry.path}
                onOpenDirectory={onOpenDirectory}
                onSelectFile={onSelectFile}
              />
            </li>
          ))}
        </ul>
      ) : (
        <WorkspaceEmpty
          title={t("workspace.no_files")}
          mark={<WorkspaceFile size={ICON.lg} />}
          announce
        />
      )}
    </div>
  );
}

export function WorkspaceFileRow({
  entry,
  selected,
  onOpenDirectory,
  onSelectFile,
}: {
  entry: WorkspaceFileEntry;
  selected: boolean;
  onOpenDirectory: (path: string) => void;
  onSelectFile: (entry: WorkspaceFileEntry) => void;
}) {
  const { t, i18n } = useTranslation();
  const isDirectory = entry.kind === "directory";
  return (
    <Button
      variant="ghost"
      type="button"
      className={`workspace-pick workspace-file-pick${selected ? " is-active" : ""}`}
      aria-pressed={selected}
      data-kind={entry.kind}
      onClick={() => (isDirectory ? onOpenDirectory(entry.path) : onSelectFile(entry))}
    >
      <span className="workspace-file-icon" aria-hidden="true">
        {isDirectory ? <WorkspaceFolder size={ICON.sm} /> : <WorkspaceFile size={ICON.sm} />}
      </span>
      <span className="workspace-pick-title">{entry.name}</span>
      <span className="workspace-pick-meta tnum">
        {isDirectory
          ? t("workspace.kind_directory")
          : formatBytes(entry.bytes, i18n.language) || t("workspace.kind_file")}
        {" · "}
        {compactDate(entry.updatedAt, i18n.language)}
      </span>
    </Button>
  );
}
