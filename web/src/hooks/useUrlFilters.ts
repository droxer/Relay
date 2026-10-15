"use client";

import { useCallback, useMemo } from "react";
import { APP_NAVIGATION_EVENT, canonicalBrowserUrl } from "../lib/appRoute";
import { parseUrlFilters, writeUrlFilters, type FilterSpec } from "../lib/urlFilters";
import { resolveUrlSearchValue, type UrlSearchStateUpdate } from "../lib/urlSearchState";
import { useLocationSearch } from "./useLocationSearch";

/**
 * A whole filter bar in the query string.
 *
 * Same store and same reasoning as `useListSort` and `usePagination`: the
 * filters are part of what the reader is looking at, so they survive opening
 * a record and coming back, and they are linkable. One hook for the whole bar
 * rather than one `useUrlSearchState` per field — a keystroke in the search
 * box would otherwise pay one history write per field.
 *
 * The value is derived from the address bar and the current `defaults`, like
 * `useUrlSearchState`. `defaults` and `spec` should still be module-level
 * constants: the parsed object is memoized on them, and fresh literals each
 * render would hand consumers a new filters object every render.
 */
export function useUrlFilters<T extends { [K in keyof T]: string }>(
  defaults: T,
  spec: FilterSpec<T>,
): [T, (value: UrlSearchStateUpdate<T>) => void] {
  const search = useLocationSearch();
  const value = useMemo(
    () => (search === null ? defaults : parseUrlFilters(search, defaults, spec)),
    [defaults, search, spec],
  );

  const update = useCallback((nextValue: UrlSearchStateUpdate<T>) => {
    // Resolved against the URL as it is now, so two updates in one handler compose.
    const url = new URL(window.location.href);
    const next = resolveUrlSearchValue(parseUrlFilters(url.search, defaults, spec), nextValue);
    writeUrlFilters(url, next, defaults, spec);
    const nextUrl = canonicalBrowserUrl(url.pathname, url.search);
    window.history.replaceState(window.history.state, "", nextUrl);
    window.dispatchEvent(new Event(APP_NAVIGATION_EVENT));
  }, [defaults, spec]);

  return [value, update];
}
