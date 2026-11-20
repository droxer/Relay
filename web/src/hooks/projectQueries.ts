import { queryOptions, type Query, type QueryClient, type QueryKey } from "@tanstack/react-query";
import { getProject, getProjectDirectoryEntry, listProjectIndex, listProjects } from "../api";
import type { PrivateResponseCache } from "../api-client/client";
import { RELAY_POLL_INTERVALS_MS } from "../lib/relayPolling";
import { projectIndexRow } from "../lib/projectDirectory";
import type { ProjectListItem, ProjectRailItem, ProjectRecord, ProjectsResponse } from "../types";

export const PROJECTS_QUERY_KEY = ["relay", "projects"] as const;
export const PROJECT_INDEX_QUERY_KEY = [...PROJECTS_QUERY_KEY, "index"] as const;
export const PROJECT_DIRECTORY_ENTRY_QUERY_KEY = ["project-directory-entry"] as const;
export const PROJECT_RECORD_QUERY_KEY = ["project-record"] as const;

const directoryValidators = new WeakMap<Query, PrivateResponseCache<ProjectsResponse>>();
const indexValidators = new WeakMap<Query, PrivateResponseCache<{ projects: ProjectRailItem[] }>>();
const entryValidators = new WeakMap<Query, PrivateResponseCache<{ project: ProjectListItem }>>();
const recordValidators = new WeakMap<Query, PrivateResponseCache<{ project: ProjectRecord }>>();

function responseCache<T>(client: QueryClient, queryKey: QueryKey, validators: WeakMap<Query, PrivateResponseCache<T>>) {
  const entry = client.getQueryCache().find({ queryKey, exact: true });
  const cache = (entry && validators.get(entry)) || {};
  if (entry) validators.set(entry, cache);
  return cache;
}

export const projectRecordKey = (id: string, version: number) => [...PROJECT_RECORD_QUERY_KEY, id, version] as const;
export const projectDirectoryEntryKey = (id: string, version: number) => [...PROJECT_DIRECTORY_ENTRY_QUERY_KEY, id, version] as const;

export function projectDirectoryOptions() {
  return queryOptions({
    queryKey: PROJECTS_QUERY_KEY,
    queryFn: async ({ signal, client, queryKey }) => (await listProjects(signal, responseCache(client, queryKey, directoryValidators))).projects ?? [],
    staleTime: RELAY_POLL_INTERVALS_MS.projects,
  });
}

export function projectIndexOptions() {
  return queryOptions({
    queryKey: PROJECT_INDEX_QUERY_KEY,
    queryFn: async ({ signal, client, queryKey }) => {
      const directory = client.getQueryState<ProjectListItem[]>(PROJECTS_QUERY_KEY);
      const index = client.getQueryState(PROJECT_INDEX_QUERY_KEY);
      if (directory?.data && !directory.isInvalidated && directory.dataUpdatedAt >= (index?.dataUpdatedAt ?? 0)
        && Date.now() - directory.dataUpdatedAt < RELAY_POLL_INTERVALS_MS.projects) {
        return directory.data.map(projectIndexRow);
      }
      const { projects = [] } = await listProjectIndex(signal, responseCache(client, queryKey, indexValidators));
      // An older server can ignore the view and return complete records.
      // Reuse them on selection while normalizing the index to one shape.
      if (!signal.aborted && projects.length
        && projects.every((project): project is ProjectListItem => "members" in project)
        && client.getQueryState(PROJECTS_QUERY_KEY) === directory) {
        client.setQueryData(PROJECTS_QUERY_KEY, projects);
      }
      return projects.map(projectIndexRow);
    },
    staleTime: RELAY_POLL_INTERVALS_MS.projects,
  });
}

export function projectDirectoryEntryOptions(id: string, version: number) {
  return queryOptions({
    queryKey: projectDirectoryEntryKey(id, version),
    queryFn: ({ signal, client, queryKey }) => {
      const record = client.getQueryData<{ project: ProjectRecord }>(projectRecordKey(id, version));
      if (record) return record;
      const cached = client.getQueryData<ProjectListItem[]>(PROJECTS_QUERY_KEY)?.find(
        project => project.id === id && project.version === version);
      return cached ? { project: cached } : getProjectDirectoryEntry(id, signal, responseCache(client, queryKey, entryValidators));
    },
    staleTime: Infinity,
  });
}

export function projectRecordOptions(id: string, version: number) {
  return queryOptions({
    queryKey: projectRecordKey(id, version),
    queryFn: async ({ signal, client, queryKey }) => {
      const result = await getProject(id, signal, responseCache(client, queryKey, recordValidators));
      if (!signal.aborted && result.project.version > version) {
        const latestKey = projectRecordKey(id, result.project.version);
        if (!client.getQueryData(latestKey)) client.setQueryData(latestKey, result);
      }
      return result;
    },
    staleTime: Infinity,
  });
}
