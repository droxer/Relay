"use client";

import { useSyncExternalStore } from "react";
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
