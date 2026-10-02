import {
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
  type Table,
} from "@tanstack/react-table";

/** A TanStack table over rows that arrive already ordered. Every list here
 *  sorts through `useListSort` (URL state + `applySort`), so the table only
 *  renders: its sorting state is a read-only projection for the header carets,
 *  and its row ids are the records' own. */
export function useManualSortTable<T extends { id: string }>(
  data: T[],
  columns: ColumnDef<T>[],
  sorting: SortingState,
): Table<T> {
  // The table instance hands back functions React Compiler cannot memoize, so
  // the compiler skips whatever component calls this. That is inherent to
  // TanStack Table; confining the call here keeps it to one site, not four.
  // eslint-disable-next-line react-hooks/incompatible-library -- see above
  return useReactTable({
    data,
    columns,
    state: { sorting },
    manualSorting: true,
    getCoreRowModel: getCoreRowModel(),
    getRowId: (row) => row.id,
  });
}
