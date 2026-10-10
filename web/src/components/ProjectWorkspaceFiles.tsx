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
  const [filePath, setFilePath] = useUrlSearchState("path", "", parseString, (value) => value || null);
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
      selectedPath={selectedPath}
      files={{ data: fileQuery.data, error: fileQuery.error, isLoading: fileQuery.isLoading }}
      content={{ data: contentQuery.data, error: contentQuery.error, isLoading: contentQuery.isLoading }}
      view={view}
      setView={setView}
      homeStatus={homeStatus}
      openDirectory={openDirectory}
      onSelectFile={(entry) => setSelectedKey(`file:${entry.path}`)}
      onRetry={() => void fileQuery.refetch()}
      onClosePreview={() => setSelectedKey("")}
    />
  );
}
