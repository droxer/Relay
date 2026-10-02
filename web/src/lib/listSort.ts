/**
 * One sort vocabulary for every full-page list.
 *
 * The lists (backlog, routines, the admin employee and node tables) each
 * arrived with a hardcoded `.sort(...)` baked into their filter function and
 * no way for the reader to change it. This module is the seam: a surface
 * declares its sortable columns once, the header renders them, and the same
 * state serialises into the URL so a sorted view is linkable.
 *
 * Two rules the comparators encode that a bare `Array.sort` does not:
 *
 * - **Missing values stay last.** A task with no due date is not "earliest";
 *   it is unscheduled. Flipping the direction must not float every blank row
 *   to the top, so `isMissing` is evaluated OUTSIDE the direction flip.
 * - **The sort is stable.** `Array.prototype.sort` is spec-stable, but only
 *   for the comparator's own ties — reversing by negating the comparator
 *   reverses ties too, which makes equal rows jitter when you toggle. The
 *   direction is applied to the column's result only, and the original index
 *   breaks every remaining tie in ascending order both ways.
 */

export type SortDirection = "asc" | "desc";

export interface SortState<K extends string> {
  key: K;
  direction: SortDirection;
}

export interface SortColumn<T, K extends string> {
  key: K;
  /** Ascending comparator, called only for rows that are not `isMissing`. */
  compare: (left: T, right: T) => number;
  /**
   * Direction the column opens on. Counts and dates read "most first", names
   * read A–Z; defaults to ascending.
   */
  defaultDirection?: SortDirection;
  /** Rows answering true sink to the bottom in BOTH directions. */
  isMissing?: (item: T) => boolean;
}

/** Sorts a copy of `items`. A null state, or a key no column declares, is a no-op. */
export function applySort<T, K extends string>(
  items: readonly T[],
  columns: readonly SortColumn<T, K>[],
  state: SortState<K> | null,
): T[] {
  if (!state) return [...items];
  const column = columns.find((candidate) => candidate.key === state.key);
  if (!column) return [...items];

  const sign = state.direction === "desc" ? -1 : 1;
  const isMissing = column.isMissing;

  return items
    .map((item, index) => ({ item, index }))
    .sort((left, right) => {
      if (isMissing) {
        const leftMissing = isMissing(left.item);
        const rightMissing = isMissing(right.item);
        // Outside the sign, deliberately: "nothing here" is never a value the
        // reader asked to see first.
        if (leftMissing !== rightMissing) return leftMissing ? 1 : -1;
        if (leftMissing) return left.index - right.index;
      }
      return column.compare(left.item, right.item) * sign || left.index - right.index;
    })
    .map((entry) => entry.item);
}

/**
 * Click cycle: unsorted → default direction → reversed → unsorted.
 *
 * The third click matters. Every one of these lists ships a considered
 * default order (backlog is priority, then due date, then recency) that no
 * single column reproduces, so without a way back the reader can leave it but
 * never return.
 */
export function nextSortState<T, K extends string>(
  current: SortState<K> | null,
  key: K,
  columns: readonly SortColumn<T, K>[],
): SortState<K> | null {
  const opening = columns.find((column) => column.key === key)?.defaultDirection ?? "asc";
  if (!current || current.key !== key) return { key, direction: opening };
  if (current.direction === opening) return { key, direction: opening === "asc" ? "desc" : "asc" };
  return null;
}

/** `?sort=due` ascending, `?sort=-due` descending, absent when unsorted. */
export function serializeSortParam<K extends string>(state: SortState<K> | null): string | null {
  if (!state) return null;
  return state.direction === "desc" ? `-${state.key}` : state.key;
}

export function parseSortParam<K extends string>(
  value: string | null | undefined,
  keys: readonly K[],
): SortState<K> | null {
  if (!value) return null;
  const direction: SortDirection = value.startsWith("-") ? "desc" : "asc";
  const key = direction === "desc" ? value.slice(1) : value;
  // A key the surface does not offer would otherwise render a header with no
  // visible active column while silently reordering nothing.
  if (!keys.includes(key as K)) return null;
  return { key: key as K, direction };
}

interface SortIndicator {
  active: boolean;
  direction: SortDirection | null;
  ariaSort: "ascending" | "descending" | "none";
}

/** What one column header needs to know about the current sort. */
export function sortIndicator<K extends string>(state: SortState<K> | null, key: K): SortIndicator {
  if (!state || state.key !== key) return { active: false, direction: null, ariaSort: "none" };
  return {
    active: true,
    direction: state.direction,
    ariaSort: state.direction === "desc" ? "descending" : "ascending",
  };
}

/* ── Comparator builders ────────────────────────────────────────────────
   Ascending only. `applySort` owns the direction. */

/** Locale-aware and case-insensitive, so "Alpha" sorts beside "alpha". */
export function byText<T>(select: (item: T) => string | null | undefined) {
  return (left: T, right: T): number =>
    (select(left) ?? "").localeCompare(select(right) ?? "", undefined, { sensitivity: "base" });
}

export function byNumber<T>(select: (item: T) => number | null | undefined) {
  return (left: T, right: T): number => (select(left) ?? 0) - (select(right) ?? 0);
}

/**
 * ISO date/timestamp strings, which compare correctly as text. Pair with
 * `isMissing` rather than substituting a sentinel date.
 */
export function byDate<T>(select: (item: T) => string | null | undefined) {
  return (left: T, right: T): number => (select(left) ?? "").localeCompare(select(right) ?? "");
}

/**
 * An enumerated column sorts by the order the domain declares, never
 * alphabetically — "high, low, normal" is not a priority ordering.
 */
export function byRank<T, V extends string>(select: (item: T) => V | null | undefined, order: readonly V[]) {
  const rank = new Map(order.map((value, index) => [value, index] as const));
  return (left: T, right: T): number => {
    const leftRank = rank.get(select(left) as V) ?? order.length;
    const rightRank = rank.get(select(right) as V) ?? order.length;
    return leftRank - rightRank;
  };
}
