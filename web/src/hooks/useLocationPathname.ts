"use client";

import { useSyncExternalStore } from "react";
import { needsTaskCollection, parseAppPath } from "../lib/appRoute";
import { parseProjectPageTab } from "../lib/projectPage";
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

function dashboardProjectSnapshot(): string | undefined {
  const location = parseAppPath(window.location.pathname);
  if (location.route !== "projects" || location.sessionId || location.composingNew || !location.projectId) return;
  const search = new URLSearchParams(window.location.search);
  if (!search.get("task") && parseProjectPageTab(search.get("tab")) === "dashboard") return location.projectId;
}

/** Scope only the Dashboard. Boards and record routing can read across Projects. */
export function useProjectDashboardTaskScope(): string | undefined {
  return useSyncExternalStore(subscribeToLocation, dashboardProjectSnapshot, () => undefined);
}
