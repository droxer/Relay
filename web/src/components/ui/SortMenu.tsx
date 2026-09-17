"use client";

import { useTranslation } from "react-i18next";

import { serializeSortParam, type SortDirection, type SortState } from "../../lib/listSort";
import { FilterSelect } from "../FiltersBar";

/**
 * The sort control for widths where the column headers are gone.
 *
 * Sorting lives on the column headers, which is the right idiom while there
 * ARE columns — but every one of these tables restacks its rows into cards on
 * a narrow screen and hides its header row, which would leave sorting
 * reachable on a laptop and unreachable on a phone. This is the same state
 * behind a different control, not a second way to sort: it is `display: none`
 * until the surface's own stylesheet reveals it at the exact width that
 * stylesheet hides the header at, so the two can never both be on screen.
 *
 * One select rather than a column picker plus a direction toggle: the toggle
 * would have to be disabled while unsorted, and a disabled control next to an
 * empty one is a worse thing to hand somebody on a phone than a slightly
 * longer list.
 */
export function SortMenu<K extends string>({
  options,
  sort,
  onSortChange,
  label,
}: {
  /** In header order. `defaultDirection` must match the surface's `SortColumn`. */
  options: readonly { key: K; label: string; defaultDirection?: SortDirection }[];
  sort: SortState<K> | null;
  onSortChange: (sort: SortState<K> | null) => void;
  label: string;
}) {
  const { t } = useTranslation();

  /* Values are the same `key` / `-key` strings the URL uses, so the select's
     value IS the serialized sort and there is no third encoding to keep in
     step with the header and the query string. */
  const choices = [
    { value: "", label: t("list.sort_none") },
    ...options.flatMap(({ key, label: column, defaultDirection = "asc" }) => {
      const ascending = { value: key, label: t("list.sort_option_ascending", { column }) };
      const descending = { value: `-${key}`, label: t("list.sort_option_descending", { column }) };
      // Lead with the direction the header opens on, so the two controls
      // present the same column the same way round.
      return defaultDirection === "desc" ? [descending, ascending] : [ascending, descending];
    }),
  ];

  return (
    <FilterSelect
      className="list-sort-menu"
      /* Always a neighbour of compact controls — the Filters chip, the admin
         fleet chips, the layout toggle — so it takes their tier, not a form
         field's. At the default size it stood 4px taller than the row. */
      size="sm"
      name="list-sort"
      label={label}
      value={serializeSortParam(sort) ?? ""}
      options={choices}
      onValueChange={(value) => {
        if (!value) return onSortChange(null);
        const direction: SortDirection = value.startsWith("-") ? "desc" : "asc";
        onSortChange({ key: (direction === "desc" ? value.slice(1) : value) as K, direction });
      }}
    />
  );
}
