"use client";

import { useQuery } from "@tanstack/react-query";
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
  PROJECT_WORKSPACE_FILE_ROOTS,
  parseWorkspaceBrowsePath,
  serializeWorkspaceBrowsePath,
} from "../lib/workspaceFileTabs";

/* A project's directory is its deliverable location, so the browser opens
   on the project root rather than an `artifacts/` folder. */
const PROJECT_BROWSE_ROOT = PROJECT_WORKSPACE_FILE_ROOTS.artifacts;
import { useUrlSearchState } from "../hooks/useUrlSearchState";
import { useWorkspaceFileView } from "./workspace/WorkspaceFilePreview";
import { WorkspaceFilePanes } from "./workspace/WorkspaceFilePanes";

const parseString = (value: string | null): string => value ?? "";

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
  const [filePath, setFilePath] = useUrlSearchState(
    "path",
    PROJECT_BROWSE_ROOT,
    (value) => parseWorkspaceBrowsePath(value, PROJECT_BROWSE_ROOT),
    (path) => serializeWorkspaceBrowsePath(path, PROJECT_BROWSE_ROOT),
  );
  const [selectedKey, setSelectedKey] = useUrlSearchState("item", "", parseString, (value) => value || null);
  const selectedPath = selectedKey.startsWith("file:") ? selectedKey.slice(5) : "";
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
  const { view, setView } = useWorkspaceFileView(selectedPath);

  function openDirectory(path: string): void {
    setFilePath(path);
    setSelectedKey("");
  }

  return (
    <WorkspaceFilePanes
      path={filePath}
      roots={PROJECT_WORKSPACE_FILE_ROOTS}
      selectedPath={selectedPath}
      files={{ data: fileQuery.data, error: fileQuery.error, isLoading: fileQuery.isLoading }}
      content={{ data: contentQuery.data, error: contentQuery.error, isLoading: contentQuery.isLoading }}
      view={view}
      setView={setView}
      homeStatus={homeStatus}
      openDirectory={openDirectory}
      onSelectFile={(entry) => setSelectedKey(`file:${entry.path}`)}
      onRetry={() => void fileQuery.refetch()}
      onRetryPreview={() => void contentQuery.refetch()}
      onClosePreview={() => setSelectedKey("")}
    />
  );
}
