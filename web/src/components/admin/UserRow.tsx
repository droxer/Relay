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
import { userHandleOf } from "../../lib/userHandle";
import { sortIndicator, type SortState } from "../../lib/listSort";
import { ActionEdit, AdminDelete, ICON } from "../icons";
import { TonePill } from "../StatusPill";
import { UserComputers } from "./UserComputers";
import { UserStatusMark } from "./UserStatusMark";
import {
  isOverLocalComputerLimit,
  localComputerUsageLabel,
  taskCapacityOf,
  type UserNodeSummary,
} from "./helpers";
import { useManualSortTable } from "../../hooks/useManualSortTable";
import { createCellState } from "../../lib/cellState";

/** The columns the user list can order by. Mirrors `userSortColumns`. */
export type UserSortKey = "user" | "computers" | "localLimit" | "running" | "ready";

/** Per-column element classes, carried through TanStack's open `meta` slot. */
type ColumnChrome = { headClass?: string; cellClass?: string };

interface UserCellState {
  t: TFunction;
  deletePending: boolean;
  onEdit?: (id: string) => void;
  onDelete?: (id: string) => void;
}

const UserCells = createCellState<UserCellState>("UserTable");

/**
 * The user roster as one table.
 *
 * Status is not a column or a band: each computer chip carries its own
 * liveness, and a row names its user's state beside the name only when it is
 * running or needs attention. Sorting itself is manual: the caller pre-orders
 * `members` through `applySort` (whose missing-sinks-both-ways semantics
 * TanStack's inversion cannot express) and this table only reflects the
 * state and reports header clicks.
 */
export function UserTable({
  label,
  members,
  sort,
  onSort,
  highlightedId,
  deletePending,
  onEdit,
  onDelete,
}: {
  /** The table's accessible name. */
  label: string;
  /** Already sorted and paged: the table renders exactly these rows. */
  members: UserNodeSummary[];
  sort: SortState<UserSortKey> | null;
  onSort: (key: UserSortKey) => void;
  highlightedId: string | null;
  deletePending: boolean;
  onEdit?: (id: string) => void;
  onDelete?: (id: string) => void;
}) {
  const { t } = useTranslation();
  // `t`, the pending flag and the caller's inline action callbacks change
  // under stable column defs; cells read them through UserCells.
  const cellState = useMemo<UserCellState>(
    () => ({ t, deletePending, onEdit, onDelete }),
    [t, deletePending, onEdit, onDelete],
  );

  const sorting = useMemo<SortingState>(
    () => (sort ? [{ id: sort.key, desc: sort.direction === "desc" }] : []),
    [sort],
  );

  const columns = useMemo<ColumnDef<UserNodeSummary>[]>(() => {
    /* TanStack's own toggle cycles asc → desc → none with no notion of a
       column's OPENING direction; the caller's `onSort` speaks the
       `nextSortState` cycle (unsorted → the column's default → reversed →
       unsorted), so the header behaves identically here and in the SortMenu. */
    function sortHead(
      key: UserSortKey,
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
        id: "user",
        meta: { headClass: "adm-emp-col-identity" } satisfies ColumnChrome,
        header: () => <UserCells.Read>{(s) => sortHead("user", s.t("admin.col_user"))}</UserCells.Read>,
        cell: ({ row }) => {
          const member = row.original;
          return (
            <>
              <div className="adm-emp-id-line">
                <p className="adm-emp-name" translate="no">{member.displayName}</p>
                <UserCells.Read>{(s) => <UserStatusMark member={member} t={s.t} />}</UserCells.Read>
              </div>
              {/* One quiet line of who they are. Task capacity joins it only
                  when pinned for this user — the org default repeated on every
                  row said nothing. */}
              <p className="adm-emp-meta">
                <span translate="no">@{userHandleOf(member)}</span>
                {member.email ? <span translate="no">{member.email}</span> : null}
                {member.departmentName ? <span>{member.departmentName}</span> : null}
                {member.maxConcurrentTasks != null ? (
                  <UserCells.Read>{(s) => <span>{s.t("admin.v2.task_capacity_summary", {
                    count: taskCapacityOf(member),
                  })}</span>}</UserCells.Read>
                ) : null}
              </p>
            </>
          );
        },
      },
      {
        id: "computers",
        header: () => <UserCells.Read>{(s) => sortHead("computers", s.t("admin.v2.col_computers"), "start", "desc")}</UserCells.Read>,
        cell: ({ row }) => <UserCells.Read>{(s) => <div className="adm-emp-nodes"><UserComputers nodes={row.original.nodes} t={s.t} /></div>}</UserCells.Read>,
      },
      {
        id: "localLimit",
        /* The metric columns are flush right, so their carets are too — a
           left-aligned control under a right-aligned number reads as a
           different column. */
        meta: { headClass: "adm-emp-col-metric text-right", cellClass: "adm-emp-col-metric text-right" } satisfies ColumnChrome,
        header: () => <UserCells.Read>{(s) => sortHead("localLimit", s.t("admin.v2.col_local_limit"), "end", "desc")}</UserCells.Read>,
        cell: ({ row }) => <UserCells.Read>{(s) => {
          const member = row.original;
          return (
            <div className="adm-emp-metric">
              {/* The card's wording, so the two layouts read one number. */}
              <span className={`adm-emp-ratio tnum ${isOverLocalComputerLimit(member) ? "" : "ink-dim"}`}>
                {member.effectiveMaxLocalComputers === undefined
                  ? localComputerUsageLabel(member)
                  : s.t("admin.v2.emp_card_computers_value", {
                    used: member.localComputerCount,
                    limit: member.effectiveMaxLocalComputers,
                  })}
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
        }}</UserCells.Read>,
      },
      {
        /* Actions is not a column of data — there is nothing to order by. */
        id: "actions",
        meta: { headClass: "adm-emp-col-actions text-right", cellClass: "adm-emp-col-actions text-right" } satisfies ColumnChrome,
        header: () => <UserCells.Read>{(s) => <span className="sr-only">{s.t("admin.v2.col_actions")}</span>}</UserCells.Read>,
        cell: ({ row }) => <UserCells.Read>{(s) => {
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
                  aria-label={say("admin.v2.edit_user_action")}
                  title={say("admin.v2.edit_user_action")}
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
                  aria-label={say("admin.v2.delete_user_action")}
                  title={say("admin.v2.delete_user_action")}
                >
                  <AdminDelete size={ICON.sm} aria-hidden="true" />
                </Button>
              ) : null}
            </div>
          );
        }}</UserCells.Read>,
      },
    ];
  }, [sort, onSort]);

  const table = useManualSortTable(members, columns, sorting);

  return (
    <UserCells.Provider value={cellState}>
      <Table data-density="compact" aria-label={label} className="adm-emp-table">
        <TableHeader>
          {table.getHeaderGroups().map((headerGroup) => (
            <TableRow key={headerGroup.id} className="hover:bg-transparent">
              {headerGroup.headers.map((header) => (
                <TableHead
                  key={header.id}
                  className={(header.column.columnDef.meta as ColumnChrome | undefined)?.headClass}
                  aria-sort={sort?.key === header.column.id ? sortIndicator(sort, header.column.id as UserSortKey).ariaSort : undefined}
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
              data-user={row.original.id}
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
    </UserCells.Provider>
  );
}
