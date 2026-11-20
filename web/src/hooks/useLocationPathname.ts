"use client";

import { useSyncExternalStore } from "react";
import { needsTaskCollection, parseAppPath, taskListScope } from "../lib/appRoute";
import { subscribeToLocation } from "./useLocationSearch";

function snapshot(): string {
  return window.location.pathname;
}

/* The prerender has no address: null while the export hydrates. */
function serverSnapshot(): null {
  return null;
}

/** The address bar's pathname, for the auth gate. Re-renders on back/forward
    and on every in-app navigation, which both announce themselves; the
    signed-in shell keeps its own richer route state in useAppRouter. */
export function useLocationPathname(): string | null {
  return useSyncExternalStore(subscribeToLocation, snapshot, serverSnapshot);
}

function taskCollectionSnapshot(): boolean {
  return needsTaskCollection(parseAppPath(window.location.pathname), new URLSearchParams(window.location.search));
}

/** Subscribe to visibility only so changing board filters never rerenders the shell. */
export function useTaskCollectionVisible(): boolean {
  return useSyncExternalStore(subscribeToLocation, taskCollectionSnapshot, () => false);
}

function taskProjectSnapshot(): string | undefined {
  const location = parseAppPath(window.location.pathname);
  if (location.route === "projects" && needsTaskCollection(location, new URLSearchParams(window.location.search))) {
    return location.projectId ?? undefined;
  }
}

export function useProjectTaskScope(): string | undefined {
  return useSyncExternalStore(subscribeToLocation, taskProjectSnapshot, () => undefined);
}

function taskListScopeSnapshot() {
  return taskListScope(parseAppPath(window.location.pathname), new URLSearchParams(window.location.search));
}

export function useTaskListScope() {
  return useSyncExternalStore(subscribeToLocation, taskListScopeSnapshot, () => undefined);
}

function projectTaskRecordSnapshot(): string | null {
  const location = parseAppPath(window.location.pathname);
  if (location.projectId && !location.sessionId) {
    const search = new URLSearchParams(window.location.search);
    return search.get("task") ?? search.get("run") ?? search.get("automation");
  }
  return null;
}

export function useProjectTaskRecordId(): string | null {
  return useSyncExternalStore(subscribeToLocation, projectTaskRecordSnapshot, () => null);
}
