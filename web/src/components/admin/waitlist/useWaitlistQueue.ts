import { keepPreviousData, useQueries } from "@tanstack/react-query";
import { listWaitlist } from "../../../api";
import type { WaitlistEntry, WaitlistStatus } from "../../../types";
import { ADMIN_ROSTER_POLL_MS, CONTROL_PANEL_POLL_MS } from "../../../lib/controlPanelQueries";
import { LANE_PAGE_SIZE } from "../../../lib/pagination";
import { pageOffset, WAITLIST_STATUS_ORDER } from "../../../lib/waitlist";

/** Every waitlist read sits under this key, so one invalidation after an
    invite, decline, note, or erase refreshes every band at once. */
export const WAITLIST_QUERY_KEY = ["admin", "waitlist"] as const;

/** Invite emails send in the background, so a band still holding a queued
    delivery polls at node pace until the outcome lands; otherwise only other
    admins change it. */
export function waitlistPollIntervalMs(entries: readonly WaitlistEntry[] | undefined): number {
  return entries?.some((entry) => entry.lastDeliveryStatus === "queued")
    ? CONTROL_PANEL_POLL_MS
    : ADMIN_ROSTER_POLL_MS;
}

export interface WaitlistBand {
  status: WaitlistStatus;
  entries: WaitlistEntry[];
  /** The band's whole size under the current search, not the page on screen. */
  total: number;
  page: number;
  loaded: boolean;
  error: Error | null;
}

export interface WaitlistQueue {
  bands: WaitlistBand[];
  /** Every band has answered at least once. */
  loaded: boolean;
  /** No band has a row under the current search. */
  empty: boolean;
}

/**
 * One server-paged read per status band. The queue can outgrow a single
 * fetch, so each band asks for its own page (oldest first) instead of the
 * list arriving whole and being grouped here. `combine` folds the four
 * results into one stable value, so a poll that changes nothing re-renders
 * nothing.
 */
export function useWaitlistQueue(query: string, lanePages: Record<string, number>): WaitlistQueue {
  return useQueries({
    queries: WAITLIST_STATUS_ORDER.map((status) => {
      const page = lanePages[status] ?? 1;
      return {
        queryKey: [...WAITLIST_QUERY_KEY, status, query, page],
        queryFn: ({ signal }: { signal: AbortSignal }) => listWaitlist(
          { status, q: query, limit: LANE_PAGE_SIZE, offset: pageOffset(page, LANE_PAGE_SIZE) },
          signal,
        ),
        placeholderData: keepPreviousData,
        refetchInterval: (query: { state: { data?: { entries?: WaitlistEntry[] } } }) =>
          waitlistPollIntervalMs(query.state.data?.entries),
      };
    }),
    combine: (results) => {
      const bands = results.map((result, index): WaitlistBand => ({
        status: WAITLIST_STATUS_ORDER[index],
        entries: result.data?.entries ?? [],
        total: result.data?.total ?? 0,
        page: lanePages[WAITLIST_STATUS_ORDER[index]] ?? 1,
        loaded: result.data !== undefined,
        error: result.error,
      }));
      const loaded = bands.every((band) => band.loaded || band.error);
      return { bands, loaded, empty: loaded && bands.every((band) => band.total === 0) };
    },
  });
}
