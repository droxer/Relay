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

function locationSnapshot(): string {
  return window.location.pathname + window.location.search;
}

/** Derive Task collection visibility and scope from the same browser address. */
export function useTaskRoute() {
  const address = useSyncExternalStore(subscribeToLocation, locationSnapshot, serverSnapshot);
  const queryStart = address?.indexOf("?") ?? -1;
  const pathname = queryStart === -1 ? address : address?.slice(0, queryStart);
  const route = pathname ? parseAppPath(pathname) : null;
  const search = route ? new URLSearchParams(queryStart === -1 ? undefined : address?.slice(queryStart)) : null;
  const visible = Boolean(route && search && needsTaskCollection(route, search));
  const projectId = route?.route === "projects" && visible ? route.projectId ?? undefined : undefined;
  const scope = route && search ? taskListScope(route, search) : undefined;
  return { route, search, visible, projectId, scope };
}
