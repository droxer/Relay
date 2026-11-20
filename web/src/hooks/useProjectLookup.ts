"use client";

import { useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { projectDirectoryOptions } from "./projectQueries";
import type { ProjectListItem } from "../types";

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
export function useProjectLookup(): (projectId: string | null | undefined) => ProjectListItem | undefined {
  const { data } = useQuery(projectDirectoryOptions());
  return useCallback(
    (projectId) => (projectId ? data?.find((project) => project.id === projectId) : undefined),
    [data],
  );
}
