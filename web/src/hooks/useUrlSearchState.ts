"use client";

import { useCallback, useMemo } from "react";
import { requestNavigation } from "../lib/navigationGuard";
import { APP_NAVIGATION_EVENT, canonicalBrowserUrl } from "../lib/appRoute";
import {
  resolveUrlSearchValue,
  type UrlSearchStateUpdate,
} from "../lib/urlSearchState";
import { useLocationSearch } from "./useLocationSearch";

/**
 * One query param as state. The value is DERIVED from the address bar plus
 * the current `parse`/`fallback` — never a copy of it — so a changed fallback
 * applies at once and nothing can drift out of step with the URL.
 */
export function useUrlSearchState<T>(
  key: string,
  fallback: T,
  parse: (value: string | null) => T,
  serialize: (value: T) => string | null,
  historyMode: "replace" | "push" = "replace",
): [T, (value: UrlSearchStateUpdate<T>) => void] {
  const search = useLocationSearch();
  const value = useMemo(
    () => (search === null ? fallback : parse(new URLSearchParams(search).get(key))),
    [fallback, key, parse, search],
  );

  const update = useCallback((nextValue: UrlSearchStateUpdate<T>) => {
    /* Everything is read at commit time, not call time: a tab write waits on
       the unsaved-changes dialog, and the URL may move while it is open. A
       functional update resolves against the value the URL holds when it
       actually lands, and the write keeps any param changed meanwhile. */
    const commit = () => {
      const url = new URL(window.location.href);
      const next = resolveUrlSearchValue(parse(url.searchParams.get(key)), nextValue);
      const encoded = serialize(next);
      if (encoded === null) url.searchParams.delete(key);
      else url.searchParams.set(key, encoded);
      const nextUrl = canonicalBrowserUrl(url.pathname, url.search);
      window.history[historyMode === "push" ? "pushState" : "replaceState"](window.history.state, "", nextUrl);
      window.dispatchEvent(new Event(APP_NAVIGATION_EVENT));
    };
    // Tabs can unmount an editor; filter and artifact writes retain their view.
    if (key === "tab") void requestNavigation(commit);
    else commit();
  }, [historyMode, key, parse, serialize]);

  return [value, update];
}
