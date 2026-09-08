"use client";

import { employeeHandleOf } from "../../lib/employeeHandle";
import type { TFunction } from "i18next";

import { Button } from "@/components/ui/button";
import { SortableColumnHeader } from "@/components/ui/SortableColumnHeader";
import type { SortState } from "../../lib/listSort";
import { ActionEdit, AdminDelete, ICON } from "../icons";
import { TonePill } from "../StatusPill";
import { EmployeeComputers } from "./EmployeeComputers";
import {
  isOverLocalComputerLimit,
  localComputerUsageLabel,
  type EmployeeNodeSummary,
} from "./helpers";
import { TableCell, TableHead, TableRow } from "@/components/ui/table";

/** The columns the employee list can order by. Mirrors `employeeSortColumns`. */
export type EmployeeSortKey = "employee" | "computers" | "localLimit" | "running" | "ready";

/**
 * The column header row, repeated once per band — same contract as the task
 * list's `BacklogRowsHead`: a single header above six bands stops naming the
 * row under the reader's eye, so each band is its own table with its own
 * header and the shared sort state puts the same caret on every copy.
 */
export function EmployeeCols({
  sort,
  onSort,
  t,
}: {
  sort: SortState<EmployeeSortKey> | null;
  onSort: (key: EmployeeSortKey) => void;
  t: TFunction;
}) {
  return (
    <TableRow className="adm-emp-cols">
      <SortableColumnHeader
        className="adm-col-label"
        label={t("admin.col_employee")}
        sortKey="employee"
        sort={sort}
        onSort={onSort}
      />
      <SortableColumnHeader
        className="adm-col-label"
        label={t("admin.v2.col_computers")}
        sortKey="computers"
        sort={sort}
        onSort={onSort}
        defaultDirection="desc"
      />
      {/* The metric columns are flush right, so their carets are too — a
          left-aligned control under a right-aligned number reads as a
          different column. */}
      <SortableColumnHeader
        className="adm-col-label adm-col-label--metrics"
        label={t("admin.v2.col_local_limit")}
        sortKey="localLimit"
        sort={sort}
        onSort={onSort}
        align="end"
        defaultDirection="desc"
      />
      <SortableColumnHeader
        className="adm-col-label adm-col-label--metrics"
        label={t("admin.v2.col_running")}
        sortKey="running"
        sort={sort}
        onSort={onSort}
        align="end"
        defaultDirection="desc"
      />
      <SortableColumnHeader
        className="adm-col-label adm-col-label--metrics"
        label={t("admin.v2.col_ready")}
        sortKey="ready"
        sort={sort}
        onSort={onSort}
        align="end"
        defaultDirection="desc"
      />
      {/* Actions is not a column of data — there is nothing to order by. */}
      <TableHead className="adm-col-label adm-col-label--metrics">{t("admin.v2.col_actions")}</TableHead>
    </TableRow>
  );
}

/**
 * One employee as a list row.
 *
 * It carries no fleet-health pill: the band above it is that pill, said once
 * for the whole group. The over-limit pill stays — it is a fact about this
 * employee's allowance, not about the band they are in.
 */
export function EmployeeRow({
  member,
  highlight,
  deletePending,
  onEdit,
  onDelete,
  t,
}: {
  member: EmployeeNodeSummary;
  highlight: boolean;
  deletePending: boolean;
  onEdit?: (id: string) => void;
  onDelete?: (id: string) => void;
  t: TFunction;
}) {
  return (
    <TableRow render={<li />}
      className={`adm-emp-row ${highlight ? "is-pulse" : ""}`}
      data-employee={member.id}
    >
      <TableCell render={<div />} className="adm-emp-id">
        <div className="adm-emp-id-line">
          <p className="adm-emp-name" translate="no">{member.displayName}</p>
        </div>
        <p className="adm-emp-meta code">
          <span translate="no">@{employeeHandleOf(member)}</span>
          {member.email ? <span translate="no">{member.email}</span> : null}
          {member.departmentName ? <span>{member.departmentName}</span> : null}
        </p>
      </TableCell>
      <TableCell render={<div />} className="adm-emp-nodes">
        <EmployeeComputers nodes={member.nodes} t={t} />
      </TableCell>
      <TableCell render={<div />} className="adm-emp-metrics">
        <div className="adm-emp-metric">
          <span className={`adm-emp-ratio tnum ${isOverLocalComputerLimit(member) ? "" : "ink-dim"}`}>
            {localComputerUsageLabel(member)}
          </span>
          {isOverLocalComputerLimit(member) ? (
            <TonePill
              tone="bad"
              label={t("admin.v2.emp_limit_over_short")}
              title={t("admin.v2.emp_limit_over")}
            />
          ) : null}
        </div>
      </TableCell>
      {/* Two columns, not one cell carrying its own caps sub-headers: those
          labels sat in the same micro-caps register as the column header
          above them, so the table appeared to have a second header row
          inside every row. */}
      <TableCell render={<div />} className="adm-emp-metrics">
        <div className="adm-emp-metric">
          <span className={`adm-emp-running tnum ${member.runningCount > 0 ? "ink-strong" : "ink-dim"}`}>
            {member.runningCount}
          </span>
        </div>
      </TableCell>
      <TableCell render={<div />} className="adm-emp-metrics">
        <div className="adm-emp-metric">
          <span className="adm-emp-ratio tnum ink-dim">
            {member.readyCount}/{member.nodeCount}
          </span>
        </div>
      </TableCell>
      <TableCell render={<div />} className="adm-emp-actions">
        {onEdit ? (
          <Button variant="icon"
            size="icon-dense"
            tinted
            type="button"
            className="adm-node-card-icon-btn"
            onClick={() => onEdit(member.id)}
            aria-label={t("admin.v2.edit_employee_action")}
            title={t("admin.v2.edit_employee_action")}
          >
            <ActionEdit size={ICON.sm} aria-hidden="true" />
          </Button>
        ) : null}
        {onDelete ? (
          <Button variant="icon"
            size="icon-dense"
            tinted
            type="button"
            danger
            className="adm-node-card-icon-btn"
            onClick={() => onDelete(member.id)}
            disabled={deletePending}
            aria-label={t("admin.v2.delete_employee_action")}
            title={t("admin.v2.delete_employee_action")}
          >
            <AdminDelete size={ICON.sm} aria-hidden="true" />
          </Button>
        ) : null}
      </TableCell>
    </TableRow>
  );
}
