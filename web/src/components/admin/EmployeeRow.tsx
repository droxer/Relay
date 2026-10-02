"use client";

import { useMemo } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import {
  flexRender,
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
import { useManualSortTable } from "../../hooks/useManualSortTable";
import { createCellState } from "../../lib/cellState";

/** The columns the employee list can order by. Mirrors `employeeSortColumns`. */
export type EmployeeSortKey = "employee" | "computers" | "localLimit" | "running" | "ready";

/** Per-column element classes, carried through TanStack's open `meta` slot. */
type ColumnChrome = { headClass?: string; cellClass?: string };

interface EmployeeCellState {
  t: TFunction;
  deletePending: boolean;
  onEdit?: (id: string) => void;
  onDelete?: (id: string) => void;
}

const EmployeeCells = createCellState<EmployeeCellState>("EmployeeGroupTable");

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
  // `t`, the pending flag and the caller's inline action callbacks change
  // under stable column defs; cells read them through EmployeeCells.
  const cellState = useMemo<EmployeeCellState>(
    () => ({ t, deletePending, onEdit, onDelete }),
    [t, deletePending, onEdit, onDelete],
  );

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
        header: () => <EmployeeCells.Read>{(s) => sortHead("employee", s.t("admin.col_employee"))}</EmployeeCells.Read>,
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
        header: () => <EmployeeCells.Read>{(s) => sortHead("computers", s.t("admin.v2.col_computers"), "start", "desc")}</EmployeeCells.Read>,
        cell: ({ row }) => <EmployeeCells.Read>{(s) => <EmployeeComputers nodes={row.original.nodes} t={s.t} />}</EmployeeCells.Read>,
      },
      {
        id: "localLimit",
        /* The metric columns are flush right, so their carets are too — a
           left-aligned control under a right-aligned number reads as a
           different column. */
        meta: { headClass: "w-20 text-right", cellClass: "w-20 text-right" } satisfies ColumnChrome,
        header: () => <EmployeeCells.Read>{(s) => sortHead("localLimit", s.t("admin.v2.col_local_limit"), "end", "desc")}</EmployeeCells.Read>,
        cell: ({ row }) => <EmployeeCells.Read>{(s) => {
          const member = row.original;
          return (
            <div className="adm-emp-metric">
              <span className={`adm-emp-ratio tnum ${isOverLocalComputerLimit(member) ? "" : "ink-dim"}`}>
                {localComputerUsageLabel(member)}
              </span>
              {isOverLocalComputerLimit(member) ? (
                <TonePill
                  tone="bad"
                  label={s.t("admin.v2.emp_limit_over_short")}
                  title={s.t("admin.v2.emp_limit_over")}
                />
              ) : null}
            </div>
          );
        }}</EmployeeCells.Read>,
      },
      {
        id: "running",
        meta: { headClass: "adm-emp-col-running text-right", cellClass: "adm-emp-col-running text-right" } satisfies ColumnChrome,
        header: () => <EmployeeCells.Read>{(s) => sortHead("running", s.t("admin.v2.col_running"), "end", "desc")}</EmployeeCells.Read>,
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
        header: () => <EmployeeCells.Read>{(s) => sortHead("ready", s.t("admin.v2.col_ready"), "end", "desc")}</EmployeeCells.Read>,
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
        header: () => <EmployeeCells.Read>{(s) => s.t("admin.v2.col_actions")}</EmployeeCells.Read>,
        cell: ({ row }) => <EmployeeCells.Read>{(s) => {
          const member = row.original;
          const { deletePending: pending, onEdit: edit, onDelete: del, t: say } = s;
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
        }}</EmployeeCells.Read>,
      },
    ];
  }, [sort, onSort]);

  const table = useManualSortTable(members, columns, sorting);

  return (
    <EmployeeCells.Provider value={cellState}>
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
    </EmployeeCells.Provider>
  );
}
