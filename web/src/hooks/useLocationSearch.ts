"use client";

import { useSyncExternalStore } from "react";
import { APP_NAVIGATION_EVENT } from "../lib/appRoute";

/* The address bar's query string as an external store. Every in-app URL
   write (`syncAppStateToUrl`, `navigateToAppPath`, the URL-state hooks)
   dispatches APP_NAVIGATION_EVENT after its History call, and back/forward
   fire popstate, so those two events are the whole change feed. The snapshot
   is a string, so an unrelated render never sees a new identity. */
export function subscribeToLocation(onChange: () => void): () => void {
  window.addEventListener("popstate", onChange);
  window.addEventListener(APP_NAVIGATION_EVENT, onChange);
  return () => {
    window.removeEventListener("popstate", onChange);
    window.removeEventListener(APP_NAVIGATION_EVENT, onChange);
  };
}

function snapshot(): string {
  return window.location.search;
}

/* Prerender has no address: callers fall back to their defaults. */
function serverSnapshot(): null {
  return null;
}

/** The current `location.search`, or null while prerendering. */
export function useLocationSearch(): string | null {
  return useSyncExternalStore<string | null>(subscribeToLocation, snapshot, serverSnapshot);
}
