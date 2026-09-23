"use client";

import { useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
} from "@tanstack/react-table";

import { Button } from "@/components/ui/button";
import { SortColumnButton } from "@/components/ui/SortableColumnHeader";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { employeeHandleOf } from "../../lib/employeeHandle";
import { sortIndicator, type SortState } from "../../lib/listSort";
import { ActionEdit, AdminDelete, ICON } from "../icons";
import { TonePill } from "../StatusPill";
import { EmployeeComputers } from "./EmployeeComputers";
import {
  isOverLocalComputerLimit,
  localComputerUsageLabel,
  type EmployeeNodeSummary,
} from "./helpers";

/** The columns the employee list can order by. Mirrors `employeeSortColumns`. */
export type EmployeeSortKey = "employee" | "computers" | "localLimit" | "running" | "ready";

/** Per-column element classes, carried through TanStack's open `meta` slot. */
type ColumnChrome = { headClass?: string; cellClass?: string };

/**
 * One status band's employees as a real table.
 *
 * Every band is its own table with its own header — a single header above six
 * bands stops naming the row under the reader's eye — and the shared sort
 * state puts the same caret on every copy. Sorting itself is manual: the
 * caller pre-orders `members` through `applySort` (whose
 * missing-sinks-both-ways semantics TanStack's inversion cannot express) and
 * this table only reflects the state and reports header clicks.
 *
 * Column geometry is ported from the old `.adm-emp-cols` grid
 * (`minmax(220px, 1.2fr) minmax(0, 2fr) 5rem 5.5rem 5rem 4.5rem`): identity
 * keeps its 220px floor, computers take the slack, and the three metric
 * columns and actions stay pinned at their rem tracks, flush right.
 */
export function EmployeeGroupTable({
  label,
  members,
  sort,
  onSort,
  highlightedId,
  deletePending,
  onEdit,
  onDelete,
}: {
  /** The band's label — also the table's accessible name. */
  label: string;
  /** Already sorted and paged: the table renders exactly these rows. */
  members: EmployeeNodeSummary[];
  sort: SortState<EmployeeSortKey> | null;
  onSort: (key: EmployeeSortKey) => void;
  highlightedId: string | null;
  deletePending: boolean;
  onEdit?: (id: string) => void;
  onDelete?: (id: string) => void;
}) {
  const { t } = useTranslation();
  /* flexRender mounts a column's cell function AS a component, so a column
     def that closes over render-volatile values — `t`, the pending flag, the
     caller's inline action callbacks — would unmount and remount every cell
     subtree each time they change. The column defs below therefore stay
     stable across those values and read them through this ref at render
     time. */
  const actionState = useRef({ t, deletePending, onEdit, onDelete });
  actionState.current = { t, deletePending, onEdit, onDelete };

  const sorting = useMemo<SortingState>(
    () => (sort ? [{ id: sort.key, desc: sort.direction === "desc" }] : []),
    [sort],
  );

  const columns = useMemo<ColumnDef<EmployeeNodeSummary>[]>(() => {
    /* TanStack's own toggle cycles asc → desc → none with no notion of a
       column's OPENING direction; the caller's `onSort` speaks the
       `nextSortState` cycle (unsorted → the column's default → reversed →
       unsorted), so the header behaves identically here and in the SortMenu. */
    function sortHead(
      key: EmployeeSortKey,
      label: string,
      align: "start" | "end" = "start",
      defaultDirection: "asc" | "desc" = "asc",
    ) {
      const { active, direction } = sortIndicator(sort, key);
      return (
        <SortColumnButton
          label={label}
          sortKey={key}
          onSort={onSort}
          align={align}
          defaultDirection={defaultDirection}
          active={active}
          direction={direction}
        />
      );
    }

    return [
      {
        id: "employee",
        meta: { headClass: "adm-emp-col-identity" } satisfies ColumnChrome,
        header: () => sortHead("employee", actionState.current.t("admin.col_employee")),
        cell: ({ row }) => {
          const member = row.original;
          return (
            <>
              <div className="adm-emp-id-line">
                <p className="adm-emp-name" translate="no">{member.displayName}</p>
              </div>
              <p className="adm-emp-meta code">
                <span translate="no">@{employeeHandleOf(member)}</span>
                {member.email ? <span translate="no">{member.email}</span> : null}
                {member.departmentName ? <span>{member.departmentName}</span> : null}
              </p>
            </>
          );
        },
      },
      {
        id: "computers",
        header: () => sortHead("computers", actionState.current.t("admin.v2.col_computers"), "start", "desc"),
        cell: ({ row }) => <EmployeeComputers nodes={row.original.nodes} t={actionState.current.t} />,
      },
      {
        id: "localLimit",
        /* The metric columns are flush right, so their carets are too — a
           left-aligned control under a right-aligned number reads as a
           different column. */
        meta: { headClass: "w-20 text-right", cellClass: "w-20 text-right" } satisfies ColumnChrome,
        header: () => sortHead("localLimit", actionState.current.t("admin.v2.col_local_limit"), "end", "desc"),
        cell: ({ row }) => {
          const member = row.original;
          return (
            <div className="adm-emp-metric">
              <span className={`adm-emp-ratio tnum ${isOverLocalComputerLimit(member) ? "" : "ink-dim"}`}>
                {localComputerUsageLabel(member)}
              </span>
              {isOverLocalComputerLimit(member) ? (
                <TonePill
                  tone="bad"
                  label={actionState.current.t("admin.v2.emp_limit_over_short")}
                  title={actionState.current.t("admin.v2.emp_limit_over")}
                />
              ) : null}
            </div>
          );
        },
      },
      {
        id: "running",
        meta: { headClass: "adm-emp-col-running text-right", cellClass: "adm-emp-col-running text-right" } satisfies ColumnChrome,
        header: () => sortHead("running", actionState.current.t("admin.v2.col_running"), "end", "desc"),
        cell: ({ row }) => {
          const member = row.original;
          return (
            <div className="adm-emp-metric">
              <span className={`adm-emp-running tnum ${member.runningCount > 0 ? "ink-strong" : "ink-dim"}`}>
                {member.runningCount}
              </span>
            </div>
          );
        },
      },
      {
        id: "ready",
        meta: { headClass: "w-20 text-right", cellClass: "w-20 text-right" } satisfies ColumnChrome,
        header: () => sortHead("ready", actionState.current.t("admin.v2.col_ready"), "end", "desc"),
        cell: ({ row }) => {
          const member = row.original;
          return (
            <div className="adm-emp-metric">
              <span className="adm-emp-ratio tnum ink-dim">
                {member.readyCount}/{member.nodeCount}
              </span>
            </div>
          );
        },
      },
      {
        /* Actions is not a column of data — there is nothing to order by. */
        id: "actions",
        meta: { headClass: "adm-emp-col-actions text-right", cellClass: "adm-emp-col-actions text-right" } satisfies ColumnChrome,
        header: () => actionState.current.t("admin.v2.col_actions"),
        cell: ({ row }) => {
          const member = row.original;
          const { deletePending: pending, onEdit: edit, onDelete: del, t: say } = actionState.current;
          if (!edit && !del) return null;
          return (
            <div className="flex items-center justify-end">
              {edit ? (
                <Button variant="icon"
                  size="icon-dense"
                  tinted
                  type="button"
                  className="adm-node-card-icon-btn"
                  onClick={() => edit(member.id)}
                  aria-label={say("admin.v2.edit_employee_action")}
                  title={say("admin.v2.edit_employee_action")}
                >
                  <ActionEdit size={ICON.sm} aria-hidden="true" />
                </Button>
              ) : null}
              {del ? (
                <Button variant="icon"
                  size="icon-dense"
                  tinted
                  type="button"
                  danger
                  className="adm-node-card-icon-btn"
                  onClick={() => del(member.id)}
                  disabled={pending}
                  aria-label={say("admin.v2.delete_employee_action")}
                  title={say("admin.v2.delete_employee_action")}
                >
                  <AdminDelete size={ICON.sm} aria-hidden="true" />
                </Button>
              ) : null}
            </div>
          );
        },
      },
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sort, onSort]);

  const table = useReactTable({
    data: members,
    columns,
    state: { sorting },
    manualSorting: true,
    getCoreRowModel: getCoreRowModel(),
    getRowId: (member) => member.id,
  });

  return (
    <Table data-density="compact" aria-label={label}>
      <TableHeader>
        {table.getHeaderGroups().map((headerGroup) => (
          <TableRow key={headerGroup.id} className="hover:bg-transparent">
            {headerGroup.headers.map((header) => (
              <TableHead
                key={header.id}
                className={(header.column.columnDef.meta as ColumnChrome | undefined)?.headClass}
                aria-sort={sort?.key === header.column.id ? sortIndicator(sort, header.column.id as EmployeeSortKey).ariaSort : undefined}
              >
                {flexRender(header.column.columnDef.header, header.getContext())}
              </TableHead>
            ))}
          </TableRow>
        ))}
      </TableHeader>
      <TableBody>
        {table.getRowModel().rows.map((row) => (
          <TableRow
            key={row.id}
            className={highlightedId === row.original.id ? "is-pulse" : undefined}
            data-employee={row.original.id}
          >
            {row.getVisibleCells().map((cell) => (
              <TableCell key={cell.id} className={(cell.column.columnDef.meta as ColumnChrome | undefined)?.cellClass}>
                {flexRender(cell.column.columnDef.cell, cell.getContext())}
              </TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
