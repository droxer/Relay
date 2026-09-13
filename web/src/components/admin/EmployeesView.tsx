"use client";

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import {
  AdminEmployees,
  ICON,
  ICON_STROKE_LARGE,
} from "../icons";
import { Button } from "@/components/ui/button";
import { useDialogs } from "@/components/ui/DialogProvider";
import { RelayEmptyState } from "@/components/RelayEmptyState";
import { SearchInput } from "@/components/ui/search-input";
import type { ControlPanelDaemonNodeRecord } from "../../types";
import { applySort } from "../../lib/listSort";
import { LANE_PAGE_SIZE, paginate } from "../../lib/pagination";
import { useLanePagination, usePagination } from "../../hooks/usePagination";
import { Pagination } from "@/components/ui/Pagination";
import { useListSort } from "../../hooks/useListSort";
import { SortMenu } from "@/components/ui/SortMenu";
import { ListGroup } from "../ListGroup";
import { employeeSortColumns } from "../../lib/adminHelpers";
import { EmployeeCols, EmployeeRow } from "./EmployeeRow";
import {
  buildEmployeeSummaries,
  employeeEmptyStateTranslationKey,
  employeesByStatus,
  EMPLOYEE_SUMMARY_STATUS_ORDER,
  type EmployeeSummaryStatusKey,
  employeeSummaryStatus,
  matchesEmployeeQuickFilter,
  type EmployeeQuickFilter,
} from "./helpers";
import { EmployeeCard } from "./EmployeeCard";
import type { StateTone } from "../StateMark";
import { AdminLayoutToggle, type AdminLayout } from "./AdminLayoutToggle";
import { Table, TableRowGroup } from "@/components/ui/table";
import { Alert } from "@/components/ui/alert";

interface EmployeesViewProps {
  employees: import("../../types").EmployeeRecord[];
  nodes: ControlPanelDaemonNodeRecord[];
  layout: AdminLayout;
  onLayoutChange: (next: AdminLayout) => void;
  onAddEmployee: () => void;
  onDeleteEmployee?: (employee: import("../../types").EmployeeRecord) => Promise<void>;
  onEditEmployee?: (employee: import("../../types").EmployeeRecord) => void;
  highlightedEmployeeId: string | null;
}

const FILTERS: EmployeeQuickFilter[] = ["all", "running", "ready", "idle", "failed", "unassigned"];

/* The band's tone. `running` takes `live` rather than `info`: a band saying
   work is in flight right now is exactly what --live is scoped to, and it is
   the same reading the row's old pill carried through `live={tone==="info"}`.
   Everything else is `employeeSummaryStatus`'s own tone. */
const EMPLOYEE_STATUS_BAND_TONE: Record<EmployeeSummaryStatusKey, StateTone> = {
  failed: "bad",
  running: "live",
  ready: "good",
  idle: "neutral",
  no_nodes: "neutral",
};

// Employee activity slices mirror the Nodes status chips (and the card status
// pill). running/ready/failed overlap by design — an employee can own one
// running and one failed node — so counts are per-predicate membership, like
// the Nodes view. "idle" is the quiet remainder: has nodes, but none are
// running, ready, or failed (e.g. provisioning/stopped), so a broken node
// surfaces under "failed" instead of hiding as idle.
function filterLabel(filter: EmployeeQuickFilter, t: TFunction): string {
  if (filter === "all") return t("admin.v2.filter_all");
  // "unassigned" here means the employee owns no computer — distinct from the
  // Nodes view, where it means a node has no employee. Use dedicated copy.
  if (filter === "unassigned") return t("admin.v2.emp_state_no_nodes");
  if (filter === "failed") return t("admin.v2.filter_failed");
  return t(`admin.v2.emp_state_${filter}`, { defaultValue: filter });
}

export function EmployeesView({
  employees,
  nodes,
  layout,
  onLayoutChange,
  onAddEmployee,
  onDeleteEmployee,
  onEditEmployee,
  highlightedEmployeeId,
}: EmployeesViewProps) {
  const { t } = useTranslation();
  const { confirm } = useDialogs();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<EmployeeQuickFilter>("all");
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const employeesById = useMemo(() => new Map(employees.map((employee) => [employee.id, employee])), [employees]);

  async function handleDeleteEmployee(employeeId: string) {
    if (!onDeleteEmployee) return;
    const employee = employeesById.get(employeeId);
    if (!employee) return;
    const ok = await confirm({
      title: t("admin.v2.delete_employee_confirm", { name: employee.displayName ?? employee.id, id: employee.id }),
      message: t("admin.v2.delete_employee_message"),
      confirmLabel: t("admin.v2.delete_employee_action"),
      tone: "danger",
    });
    if (!ok) return;
    setPendingDelete(employeeId);
    setDeleteError(null);
    try {
      await onDeleteEmployee(employee);
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : String(error));
    } finally {
      setPendingDelete(null);
    }
  }

  const summaries = useMemo(() => buildEmployeeSummaries(employees, nodes), [employees, nodes]);

  const counts = useMemo(() => {
    const result: Record<EmployeeQuickFilter, number> = { all: summaries.length, running: 0, ready: 0, idle: 0, failed: 0, unassigned: 0 };
    for (const member of summaries) {
      if (matchesEmployeeQuickFilter(member, "running")) result.running += 1;
      if (matchesEmployeeQuickFilter(member, "ready")) result.ready += 1;
      if (matchesEmployeeQuickFilter(member, "idle")) result.idle += 1;
      if (matchesEmployeeQuickFilter(member, "failed")) result.failed += 1;
      if (matchesEmployeeQuickFilter(member, "unassigned")) result.unassigned += 1;
    }
    return result;
  }, [summaries]);

  const sortColumns = useMemo(() => employeeSortColumns(), []);
  // A distinct param: the admin page keeps Employees and Nodes on one route,
  // so a bare `sort` would have the two tables fighting over one key.
  const { sort, toggleSort, setSort } = useListSort(sortColumns, "employeeSort");
  const { page, setPage } = usePagination("employeePage");
  const { lanePages: groupPages, setLanePage: setGroupPage } = useLanePagination(EMPLOYEE_SUMMARY_STATUS_ORDER, "employeeLanes");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matching = summaries.filter((item) => {
      if (!matchesEmployeeQuickFilter(item, filter)) return false;
      if (!q) return true;
      // Computers are what the row shows, so they are what search matches —
      // both the display name and the node id, since either can be on screen.
      const haystack = [
        item.id,
        item.displayName,
        item.email ?? "",
        item.departmentName ?? "",
        ...item.nodes.map((node) => `${node.displayName ?? ""} ${node.id}`),
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(q);
    });
    // Unsorted, `buildEmployeeSummaries`' id order stands — applySort is identity.
    return applySort(matching, sortColumns, sort);
  }, [summaries, query, filter, sort, sortColumns]);

  // One cursor for both layouts: switching card/list keeps the reader on the
  // same people rather than resetting them to the top of the roster.
  const paged = paginate(filtered, page);
  const grouped = useMemo(() => employeesByStatus(filtered), [filtered]);
  const pagedGroups = useMemo(
    () => Object.fromEntries(EMPLOYEE_SUMMARY_STATUS_ORDER.map((key) => [
      key,
      paginate(grouped[key], groupPages[key] ?? 1, LANE_PAGE_SIZE),
    ])) as Record<EmployeeSummaryStatusKey, ReturnType<typeof paginate<ReturnType<typeof buildEmployeeSummaries>[number]>>>,
    [grouped, groupPages],
  );

  if (summaries.length === 0) {
    return (
      <RelayEmptyState
        className="adm-employees-empty"
        fill
        title={t("admin.v2.empty_employees_title")}
        body={t("admin.v2.empty_employees_body")}
        illustration={<AdminEmployees size={ICON.hero} strokeWidth={ICON_STROKE_LARGE} aria-hidden="true" />}
        actions={(
          <Button type="button" onClick={onAddEmployee}>
            {t("admin.v2.add_employee_cta")}
          </Button>
        )}
      />
    );
  }

  return (
    <div className="adm-view">
      <div className="adm-view-controls">
        <div className="adm-fleet-filters" role="group" aria-label={t("admin.v2.filter_label")}>
          {FILTERS.map((id) => {
            const active = filter === id;
            return (
              <Button
                variant="outline"
                size="dense"
                key={id}
                type="button"
                className="adm-fleet-chip"
                data-active={active ? "true" : "false"}
                aria-pressed={active}
                onClick={() => setFilter(id)}
              >
                <span>{filterLabel(id, t)}</span>
                <span className="adm-fleet-chip-count tnum">{counts[id]}</span>
              </Button>
            );
          })}
        </div>
        {/* Sits with the layout toggle, not inside the filter chips: at the
            widths it appears, it is the only way to sort at all. */}
        <SortMenu
          options={[
                  { key: "employee", label: t("admin.col_employee") },
                  { key: "computers", label: t("admin.v2.col_computers"), defaultDirection: "desc" as const },
                  { key: "localLimit", label: t("admin.v2.col_local_limit"), defaultDirection: "desc" as const },
                  { key: "running", label: t("admin.v2.col_running"), defaultDirection: "desc" as const },
                  { key: "ready", label: t("admin.v2.col_ready"), defaultDirection: "desc" as const },
        ]}
          sort={sort}
          onSortChange={setSort}
          label={t("admin.v2.nav_employees", { defaultValue: "Employees" })}
        />
        <AdminLayoutToggle layout={layout} onChange={onLayoutChange} />
      </div>

      <SearchInput
        className="relay-search adm-search"
        inputClassName="adm-search-input"
        label={t("admin.v2.search_employees_placeholder")}
        name="admin-employees-search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder={t("admin.v2.search_employees_placeholder")}
      />

      {deleteError ? (
        <Alert className="mb-4">{t("admin.v2.action_failed", { message: deleteError })}</Alert>
      ) : null}

      {filtered.length === 0 ? (
        <RelayEmptyState
          className="adm-employees-empty"
          fill
          title={t(employeeEmptyStateTranslationKey(query, filter))}
        />
      ) : layout === "card" ? (
        <div className="adm-fleet-grid">
          {paged.items.map((member) => (
            <EmployeeCard
              key={member.id}
              member={member}
              highlight={highlightedEmployeeId === member.id}
              onDelete={onDeleteEmployee ? (id) => void handleDeleteEmployee(id) : undefined}
              onEdit={onEditEmployee ? (id) => {
                const employee = employeesById.get(id);
                if (employee) onEditEmployee(employee);
              } : undefined}
              deletePending={pendingDelete !== null}
              t={t}
            />
          ))}
        </div>
      ) : (
        /* Grouped by fleet health — the reason an admin opens this list. The
           per-row status pill went with it: the band is that pill, said once
           for the whole group instead of once per employee. */
        <div className="adm-grouped-list">
          {EMPLOYEE_SUMMARY_STATUS_ORDER.map((key) => {
            const group = grouped[key];
            if (group.length === 0) return null;
            const label = t(`admin.v2.emp_state_${key}`, { defaultValue: key });
            const groupPage = pagedGroups[key];
            return (
              <ListGroup
                key={key}
                label={label}
                count={group.length}
                tone={EMPLOYEE_STATUS_BAND_TONE[key]}
              >
                <Table className="list-group-rows" data-density="compact" aria-label={label}>
                  <EmployeeCols sort={sort} onSort={toggleSort} t={t} />
                  <TableRowGroup className="adm-emp-list" render={<ul />}>
                    {groupPage.items.map((member) => (
                      <EmployeeRow
                        key={member.id}
                        member={member}
                        highlight={highlightedEmployeeId === member.id}
                        deletePending={pendingDelete !== null}
                        onEdit={onEditEmployee ? (id) => {
                          const employee = employeesById.get(id);
                          if (employee) onEditEmployee(employee);
                        } : undefined}
                        onDelete={onDeleteEmployee ? (id) => void handleDeleteEmployee(id) : undefined}
                        t={t}
                      />
                    ))}
                  </TableRowGroup>
                </Table>
                <Pagination
                  compact
                  className="list-group-pager"
                  page={groupPage}
                  onPageChange={(next) => setGroupPage(key, next)}
                  label={label}
                />
              </ListGroup>
            );
          })}
        </div>
      )}

      {/* The CARD layout is a flat grid and pages off one cursor. The list
          groups, so it pages per band — one cursor over the whole list would
          empty a band because of the cursor rather than because nobody is in
          that state. */}
      {layout === "card" ? (
        <Pagination page={paged} onPageChange={setPage} label={t("admin.v2.nav_employees", { defaultValue: "Employees" })} />
      ) : null}
    </div>
  );
}
