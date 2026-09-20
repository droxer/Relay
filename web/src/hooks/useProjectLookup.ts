"use client";

import { useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { listProjects } from "../api";
import { PROJECTS_QUERY_KEY } from "./useRelayData";
import type { ProjectRecord } from "../types";

/**
 * The project a record belongs to, for surfaces that hold only a `projectId`.
 *
 * Shares the app's projects cache entry rather than fetching its own: the
 * shell already polls this key, so this observer normally renders straight
 * from cache and only fetches when a record surface is the first thing on
 * screen. It deliberately does not poll — a project's name is not why anyone
 * has a task record open.
 *
 * A task reaches its project from `/backlog` just as easily as from the
 * project page, so whether the project is closed for work has to be
 * resolvable from the task alone. That is why this is a lookup and not a
 * prop threaded down from the project page.
 */
export function useProjectLookup(): (projectId: string | null | undefined) => ProjectRecord | undefined {
  const { data } = useQuery({
    queryKey: PROJECTS_QUERY_KEY,
    queryFn: async ({ signal }): Promise<ProjectRecord[]> => (await listProjects(signal)).projects ?? [],
    staleTime: 60_000,
  });
  return useCallback(
    (projectId) => (projectId ? data?.find((project) => project.id === projectId) : undefined),
    [data],
  );
}
