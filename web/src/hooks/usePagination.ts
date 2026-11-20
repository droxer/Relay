"use client";

import { useCallback } from "react";
import { useUrlSearchState } from "./useUrlSearchState";
import {
  parseLanePages,
  parsePageParam,
  serializeLanePages,
  serializePageParam,
  type LanePages,
} from "../lib/pagination";

/**
 * Current page for a list surface, persisted in the query string.
 *
 * Same store and same reasoning as `useListSort`: a page is part of what the
 * reader is looking at, so it survives opening a record and coming back, and
 * it is linkable. Note this holds the REQUESTED page — `paginate` clamps it
 * for display, so no effect here has to watch the filters.
 *
 * `param` defaults to `page`; pass a distinct name when two independent lists
 * can be on screen at once.
 */
export function usePagination(param = "page"): {
  page: number;
  setPage: (page: number) => void;
} {
  const [page, setPageState] = useUrlSearchState<number>(
    param,
    1,
    parsePageParam,
    serializePageParam,
  );
  const setPage = useCallback((next: number) => setPageState(Math.max(1, next)), [setPageState]);
  return { page, setPage };
}

/**
 * Per-lane page cursors for a board, persisted as one query param.
 *
 * One param rather than one per lane: seven `?backlogPage=&runningPage=…`
 * keys would be seven entries in the route's ownership registry and a URL
 * nobody can read. See `serializeLanePages` for the encoding.
 */
export function useLanePagination(
  laneOrder: readonly string[],
  param = "lanes",
): {
  lanePages: LanePages;
  setLanePage: (lane: string, page: number) => void;
  resetLanePages: () => void;
} {
  const parse = useCallback(
    (value: string | null) => parseLanePages(value, laneOrder),
    [laneOrder],
  );
  const serialize = useCallback(
    (pages: LanePages) => serializeLanePages(pages, laneOrder),
    [laneOrder],
  );

  const [lanePages, setLanePages] = useUrlSearchState<LanePages>(param, EMPTY_LANE_PAGES, parse, serialize);

  const setLanePage = useCallback((lane: string, page: number) => {
    setLanePages((current) => {
      const next = { ...current };
      // Page 1 is the default, so it is an ABSENCE rather than a value —
      // storing it would put every visited lane in the URL forever.
      if (page <= 1) delete next[lane];
      else next[lane] = page;
      return next;
    });
  }, [setLanePages]);

  const resetLanePages = useCallback(() => setLanePages(EMPTY_LANE_PAGES), [setLanePages]);
  return { lanePages, setLanePage, resetLanePages };
}

/* Module-level so the fallback is referentially stable — `useUrlSearchState`
   takes it as a dependency, and a fresh `{}` each render would re-subscribe
   the navigation listener on every keystroke. */
const EMPTY_LANE_PAGES: LanePages = {};
