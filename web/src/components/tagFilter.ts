import { createContext, useMemo } from "react";

/**
 * The tag filter of the list a tag is drawn in, when that list has one.
 *
 * A board, table, or record that sits on a filterable list provides it, and
 * every `TaskTagList` under it draws its tags as toggles: a click filters the
 * list by that tag, and a second click on the tag already filtered clears it.
 * Without a provider — a notification, a picker, anywhere a filter would
 * mean nothing — tags stay plain badges. `active` is the filter's value as
 * the URL holds it ("all" when off); `onSelect` receives the next value.
 */
export type TagFilter = {
  active: string;
  onSelect: (tag: string) => void;
};

export const TagFilterContext = createContext<TagFilter | null>(null);

/**
 * A list page's two tag filters: `list` for its rows and tiles, and `record`
 * for the record drawer open over it, which also closes the record so the
 * reader lands on the list the tag just filtered. The filter is written
 * before the record closes, because closing rebuilds the address from the
 * one the filter has just updated.
 */
export function useTagFilters(
  active: string,
  apply: (tag: string) => void,
  closeRecord: () => void,
): { list: TagFilter; record: TagFilter } {
  return useMemo(() => ({
    list: { active, onSelect: apply },
    record: { active, onSelect: (tag: string) => { apply(tag); closeRecord(); } },
  }), [active, apply, closeRecord]);
}
