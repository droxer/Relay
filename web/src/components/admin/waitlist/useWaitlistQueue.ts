import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { listWaitlistQueue } from "../../../api";
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

interface WaitlistBand {
  status: WaitlistStatus;
  entries: WaitlistEntry[];
  /** The band's whole size under the current search, not the page on screen. */
  total: number;
  page: number;
}

interface WaitlistQueue {
  bands: WaitlistBand[];
  /** Every band has answered at least once. */
  loaded: boolean;
  /** No band has a row under the current search. */
  empty: boolean;
  error: Error | null;
}

/** Read one bounded page per status through a single account-scoped query. */
export function useWaitlistQueue(query: string, lanePages: Record<string, number>): WaitlistQueue {
  const offsets = Object.fromEntries(WAITLIST_STATUS_ORDER.map((status) =>
    [status, pageOffset(lanePages[status] ?? 1, LANE_PAGE_SIZE)],
  )) as Record<WaitlistStatus, number>;
  const result = useQuery({
    queryKey: [...WAITLIST_QUERY_KEY, query, offsets],
    queryFn: ({ signal }) => listWaitlistQueue(query, LANE_PAGE_SIZE, offsets, signal),
    placeholderData: keepPreviousData,
    refetchInterval: ({ state }) => waitlistPollIntervalMs(state.data?.bands.invited.entries),
  });
  const bands = WAITLIST_STATUS_ORDER.map((status): WaitlistBand => ({
    status,
    entries: result.data?.bands[status].entries ?? [],
    total: result.data?.bands[status].total ?? 0,
    page: lanePages[status] ?? 1,
  }));
  const loaded = result.data !== undefined || result.isError;
  return { bands, loaded, empty: loaded && bands.every((band) => band.total === 0), error: result.error };
}
