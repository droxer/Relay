"use client";

import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { WaitlistInviteResult } from "../../../types";
import { SearchInput } from "@/components/ui/search-input";
import { Pagination } from "@/components/ui/Pagination";
import { Alert } from "@/components/ui/alert";
import { RelayEmptyState } from "@/components/RelayEmptyState";
import { ListGroup } from "../../ListGroup";
import { AdminInbox, ICON, ICON_STROKE_LARGE } from "../../icons";
import { useDebouncedValue } from "../../../hooks/useDebouncedValue";
import { useLanePagination } from "../../../hooks/usePagination";
import { LANE_PAGE_SIZE } from "../../../lib/pagination";
import { serverPage, WAITLIST_STATUS_ORDER, WAITLIST_STATUS_TONE } from "../../../lib/waitlist";
import { InviteReveal } from "./InviteReveal";
import { WaitlistGroupTable } from "./WaitlistGroupTable";
import { useWaitlistQueue } from "./useWaitlistQueue";

/** Long enough that a typed address is one request, not one per keystroke. */
const SEARCH_DEBOUNCE_MS = 250;

interface WaitlistViewProps {
  /** Whether people can ask to join; off, the section holds only the
      invitations admins sent, and its empty state says so. */
  waitlistOpen: boolean;
  /** Links minted this visit, held by the page so the header's "Invite next N"
      and a row's Invite land in the same reveal. */
  invites: WaitlistInviteResult[] | null;
  onInvited: (results: WaitlistInviteResult[]) => void;
  onDismissInvites: () => void;
}

/**
 * Admin → Waitlist: the queue, grouped by where each request stands (Waiting,
 * Invited, Joined, Declined) like every other admin list. Each band pages on
 * the server, oldest first — that is the order people asked in — and the
 * search narrows every band at once.
 */
export function WaitlistView({ waitlistOpen, invites, onInvited, onDismissInvites }: WaitlistViewProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const settledQuery = useDebouncedValue(query.trim(), SEARCH_DEBOUNCE_MS);
  const { lanePages, setLanePage } = useLanePagination(WAITLIST_STATUS_ORDER, "waitlistLanes");
  const queue = useWaitlistQueue(settledQuery, lanePages);
  const failed = queue.bands.find((band) => band.error)?.error ?? null;

  // A narrower search can leave a band with fewer pages than the one open, so
  // a new search starts every band from its first page.
  function handleSearch(next: string) {
    setQuery(next);
    for (const status of WAITLIST_STATUS_ORDER) {
      if ((lanePages[status] ?? 1) > 1) setLanePage(status, 1);
    }
  }

  return (
    <div className="adm-view">
      <div className="adm-view-controls">
        <SearchInput
          className="relay-search adm-search"
          inputClassName="adm-search-input"
          label={t("admin.waitlist.search_placeholder")}
          name="admin-waitlist-search"
          value={query}
          onChange={(event) => handleSearch(event.target.value)}
          placeholder={t("admin.waitlist.search_placeholder")}
        />
      </div>

      {invites ? <InviteReveal invites={invites} onDismiss={onDismissInvites} /> : null}

      {failed ? (
        <Alert>{t("admin.fetch_error", { message: failed.message })}</Alert>
      ) : null}

      {!queue.loaded ? (
        <div className="route-loading" role="status" aria-live="polite">{t("admin.loading")}</div>
      ) : queue.empty ? (
        <RelayEmptyState
          className="adm-users-empty"
          fill
          title={settledQuery
            ? t("admin.waitlist.empty_search")
            : t(waitlistOpen ? "admin.waitlist.empty_title" : "admin.waitlist.empty_title_closed")}
          body={settledQuery
            ? undefined
            : t(waitlistOpen ? "admin.waitlist.empty_body" : "admin.waitlist.empty_body_closed")}
          illustration={<AdminInbox size={ICON.hero} strokeWidth={ICON_STROKE_LARGE} aria-hidden="true" />}
        />
      ) : (
        <div className="adm-grouped-list">
          {queue.bands.map((band) => {
            if (band.total === 0) return null;
            const label = t(`admin.waitlist.status_${band.status}`);
            const page = serverPage(band.entries, band.page, band.total, LANE_PAGE_SIZE);
            return (
              <ListGroup key={band.status} label={label} count={band.total} tone={WAITLIST_STATUS_TONE[band.status]}>
                <WaitlistGroupTable label={label} entries={band.entries} onInvited={onInvited} />
                <Pagination
                  compact
                  className="list-group-pager"
                  page={page}
                  onPageChange={(next) => setLanePage(band.status, next)}
                  label={label}
                />
              </ListGroup>
            );
          })}
        </div>
      )}
    </div>
  );
}
