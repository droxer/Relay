"use client";

import { useTranslation } from "react-i18next";

import type { SortDirection } from "../../lib/listSort";
import { ICON, SortAscending, SortDescending, SortInactive } from "../icons";
import { Button } from "@/components/ui/button";

/** A sortable column header's control: button, caret, announced label. Built
    for TanStack column-def headers, which render inside a TableHead they do
    not own. */
export function SortColumnButton<K extends string>({
  label,
  sortKey,
  onSort,
  align,
  defaultDirection = "asc",
  active,
  direction,
}: {
  label: string;
  sortKey: K;
  onSort: (key: K) => void;
  align: "start" | "end";
  defaultDirection?: SortDirection;
  active: boolean;
  direction: SortDirection | null;
}) {
  const { t } = useTranslation();

  return (
    <Button
      variant="ghost"
      type="button"
      className="list-sort-button"
      data-active={active ? "true" : "false"}
      data-align={align}
      onClick={() => onSort(sortKey)}
      aria-label={sortActionLabel(t, label, direction, defaultDirection)}
    >
      <span className="list-sort-label">{label}</span>
      <SortCaret direction={direction} />
    </Button>
  );
}

/**
 * The caret reserves its box on every sortable column, active or not — an
 * icon that appears only on the sorted column shifts the other labels
 * sideways the moment you click one.
 */
function SortCaret({ direction }: { direction: SortDirection | null }) {
  const Glyph = direction === "asc" ? SortAscending : direction === "desc" ? SortDescending : SortInactive;
  return <Glyph className="list-sort-caret" size={ICON.xs} aria-hidden="true" />;
}

function sortActionLabel(
  t: ReturnType<typeof useTranslation>["t"],
  label: string,
  direction: SortDirection | null,
  defaultDirection: SortDirection,
): string {
  // Announces the outcome of the NEXT press, so it has to mirror the cycle in
  // `nextSortState` exactly: unsorted → the column's default direction →
  // reversed → unsorted.
  if (direction === null) return sortDirectionLabel(t, label, defaultDirection);
  if (direction === defaultDirection) {
    return sortDirectionLabel(t, label, defaultDirection === "asc" ? "desc" : "asc");
  }
  return t("list.sort_clear", { column: label });
}

function sortDirectionLabel(
  t: ReturnType<typeof useTranslation>["t"],
  label: string,
  direction: SortDirection,
): string {
  return direction === "desc"
    ? t("list.sort_by_descending", { column: label })
    : t("list.sort_by_ascending", { column: label });
}
