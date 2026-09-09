"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { requestNavigation } from "../lib/navigationGuard";
import { APP_NAVIGATION_EVENT, canonicalBrowserUrl } from "../lib/appRoute";
import {
  resolveUrlSearchValue,
  type UrlSearchStateUpdate,
} from "../lib/urlSearchState";

export function useUrlSearchState<T>(
  key: string,
  fallback: T,
  parse: (value: string | null) => T,
  serialize: (value: T) => string | null,
  historyMode: "replace" | "push" = "replace",
): [T, (value: UrlSearchStateUpdate<T>) => void] {
  const read = useCallback(() => {
    if (typeof window === "undefined") return fallback;
    return parse(new URL(window.location.href).searchParams.get(key));
  }, [fallback, key, parse]);
  const [value, setValue] = useState<T>(read);
  const valueRef = useRef(value);

  useEffect(() => {
    const sync = () => {
      const next = read();
      valueRef.current = next;
      setValue(next);
    };
    window.addEventListener("popstate", sync);
    window.addEventListener(APP_NAVIGATION_EVENT, sync);
    return () => {
      window.removeEventListener("popstate", sync);
      window.removeEventListener(APP_NAVIGATION_EVENT, sync);
    };
  }, [read]);

  const update = useCallback((nextValue: UrlSearchStateUpdate<T>) => {
    const next = resolveUrlSearchValue(valueRef.current, nextValue);
    const url = new URL(window.location.href);
    const encoded = serialize(next);
    if (encoded === null) url.searchParams.delete(key);
    else url.searchParams.set(key, encoded);
    const nextUrl = canonicalBrowserUrl(url.pathname, url.search);
    const commit = () => {
      valueRef.current = next;
      setValue(next);
      window.history[historyMode === "push" ? "pushState" : "replaceState"](window.history.state, "", nextUrl);
      window.dispatchEvent(new Event(APP_NAVIGATION_EVENT));
    };
    // Tabs can unmount an editor; filter and artifact writes retain their view.
    if (key === "tab") void requestNavigation(commit);
    else commit();
  }, [historyMode, key, serialize]);

  return [value, update];
}
