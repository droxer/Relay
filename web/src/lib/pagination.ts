/**
 * One pagination vocabulary for every list and card surface.
 *
 * Client-side by design: these collections already arrive whole (the backlog,
 * routine, employee, and node endpoints return the full set, and the filter,
 * search, and sort layers all run over that set locally). Paging on the server
 * would mean filtering a page instead of paging the filtered result, which
 * gets the semantics backwards — you would search one screenful. When a
 * collection outgrows a single fetch, the seam to change is the query, not
 * this module.
 *
 * Page numbers here are 1-based everywhere: in the URL, in this API, and on
 * screen. There is no 0-based half of the system to convert at.
 */

/** Rows per page. One constant so surfaces do not each invent a number. */
export const DEFAULT_PAGE_SIZE = 25;

export interface Page<T> {
  items: T[];
  /** The page actually shown — clamped into range, so it can differ from the request. */
  page: number;
  pageCount: number;
  total: number;
  /** 1-based inclusive range of `total` on screen; both 0 when empty. */
  from: number;
  to: number;
  /** False when everything fits on one page — the control renders nothing. */
  needed: boolean;
}

/**
 * The requested page is CLAMPED rather than trusted. The reader sitting on
 * page 3 who then narrows a filter to four results would otherwise be shown an
 * empty list, which reads as "no matches" when in fact there are four.
 * Clamping is derived per render, so no effect has to chase the filters and
 * reset a stored page.
 */
export function paginate<T>(
  items: readonly T[],
  requestedPage: number,
  pageSize: number = DEFAULT_PAGE_SIZE,
): Page<T> {
  const total = items.length;
  const size = Math.max(1, Math.floor(pageSize));
  const pageCount = Math.max(1, Math.ceil(total / size));
  const page = Math.min(Math.max(1, Math.floor(requestedPage) || 1), pageCount);
  const start = (page - 1) * size;
  const slice = items.slice(start, start + size);
  return {
    items: slice,
    page,
    pageCount,
    total,
    from: total === 0 ? 0 : start + 1,
    to: total === 0 ? 0 : start + slice.length,
    needed: pageCount > 1,
  };
}

/** The rendered ellipsis. Not a page — it is never a navigation target. */
type PageGap = "gap";

/**
 * The page buttons to render: the first page, the last page, a window around
 * the current one, and gaps for what is elided.
 *
 * A gap is only emitted when it hides MORE than one page — "…" standing in
 * for a single page 4 is both wider than the button it replaced and unusable.
 */
export function pageNumbers(current: number, pageCount: number, window = 1): (number | PageGap)[] {
  if (pageCount <= 1) return [];

  /* The window keeps a CONSTANT width by sliding, not by clipping: at page 1
     it runs 1-2-3 rather than 1-2. A window that shrank at the ends would
     change the control's width as the reader pages through, moving the Next
     button out from under the pointer they are clicking it with. */
  const span = window * 2 + 1;
  const start = Math.max(1, Math.min(current - window, pageCount - span + 1));
  const end = Math.min(pageCount, start + span - 1);

  const shown = new Set<number>([1, pageCount]);
  for (let page = start; page <= end; page += 1) shown.add(page);

  const ordered = [...shown].sort((left, right) => left - right);
  const result: (number | PageGap)[] = [];
  for (const [index, page] of ordered.entries()) {
    const previous = ordered[index - 1];
    if (previous !== undefined) {
      // Exactly one page missing: render it rather than an ellipsis.
      if (page - previous === 2) result.push(previous + 1);
      else if (page - previous > 2) result.push("gap");
    }
    result.push(page);
  }
  return result;
}

/** `?page=3`; absent on page 1, so the default view keeps a clean URL. */
export function serializePageParam(page: number): string | null {
  return page > 1 ? String(page) : null;
}

export function parsePageParam(value: string | null | undefined): number {
  if (!value) return 1;
  // Deliberately strict: `Number` would accept "1e9", " 4 " and "1.5".
  if (!/^\d+$/.test(value)) return 1;
  const page = Number(value);
  return Number.isSafeInteger(page) && page >= 1 ? page : 1;
}

/* ── Per-lane paging, for the board ─────────────────────────────────────
   A kanban board cannot take one cursor. Page 2 of a board drawn across all
   its lanes at once would empty a lane because of the cursor rather than
   because nothing is in that state, and dropping a card into a lane whose
   contents are a page of an unseen whole has no defined meaning. So each lane
   pages independently, and the URL carries the lanes that are off page 1. */

/** A lane is one narrow column, not the whole viewport. */
export const LANE_PAGE_SIZE = 10;

export type LanePages = Record<string, number>;

/**
 * `?lanes=running:2,review:3` — only the lanes that are off page 1.
 *
 * Naming all seven lanes when six of them are on page 1 makes the common URL
 * unreadable, and the omission is unambiguous: absent means page 1. Lanes are
 * emitted in BOARD order rather than click order, so paging around the board
 * and back yields the same string instead of churning history.
 */
export function serializeLanePages(pages: LanePages, laneOrder: readonly string[]): string | null {
  const encoded = laneOrder
    .filter((lane) => (pages[lane] ?? 1) > 1)
    .map((lane) => `${lane}:${pages[lane]}`)
    .join(",");
  return encoded || null;
}

export function parseLanePages(
  value: string | null | undefined,
  laneOrder: readonly string[],
): LanePages {
  if (!value) return {};
  const lanes = new Set(laneOrder);
  const pages: LanePages = {};
  for (const entry of value.split(",")) {
    const [lane, rawPage] = entry.split(":");
    // A stale link naming a retired status, or a page that is not one, is
    // dropped rather than half-honoured — same contract as `parsePageParam`.
    if (!lanes.has(lane)) continue;
    const page = parsePageParam(rawPage);
    if (page > 1) pages[lane] = page;
  }
  return pages;
}
