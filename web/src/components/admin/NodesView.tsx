"use client";

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { RelayEmptyState } from "@/components/RelayEmptyState";
import { Button } from "@/components/ui/button";
import type { ControlPanelDaemonNodeRecord, EmployeeRecord } from "../../types";
import {
  AdminNode,
  ICON,
  ICON_STROKE_LARGE,
} from "../icons";
import { SearchInput } from "@/components/ui/search-input";
import { canUseLocalControlPanel } from "../../lib/controlPanel";
import {
  matchesNodeQuickFilter,
  nodesByStatus,
  nodeSortColumns,
  stableNodeOrder,
  statusTone,
  type NodeQuickFilter,
  type NodeSortKey,
} from "../../lib/adminHelpers";
import { applySort, type SortState } from "../../lib/listSort";
import { LANE_PAGE_SIZE, paginate } from "../../lib/pagination";
import { useLanePagination, usePagination } from "../../hooks/usePagination";
import { Pagination } from "@/components/ui/Pagination";
import { useListSort } from "../../hooks/useListSort";
import { SortableColumnHeader } from "@/components/ui/SortableColumnHeader";
import { SortMenu } from "@/components/ui/SortMenu";
import type { StoredNodeTokenMap } from "./helpers";
import { NodeCard } from "./NodeCard";
import { NodeRow } from "./NodeRow";
import { AdminLayoutToggle, type AdminLayout } from "./AdminLayoutToggle";
import { ListGroup } from "../ListGroup";
import type { StateTone } from "../StateMark";
import { Table, TableHead, TableRow, TableRowGroup } from "@/components/ui/table";

interface NodesViewProps {
  nodes: ControlPanelDaemonNodeRecord[];
  employees: EmployeeRecord[];
  storedTokens: StoredNodeTokenMap;
  layout: AdminLayout;
  onLayoutChange: (next: AdminLayout) => void;
  onRevealCredentials: (node: ControlPanelDaemonNodeRecord) => void;
  onRenameNode: (node: ControlPanelDaemonNodeRecord) => void;
  onManageExecutors: (node: ControlPanelDaemonNodeRecord) => void;
  onDeleteNode?: (node: ControlPanelDaemonNodeRecord) => Promise<void>;
  onAddNode?: () => void;
  /** The computer just created from this console, marked once on arrival. */
  highlightedNodeId?: string | null;
}

const FILTERS: NodeQuickFilter[] = ["all", "ready", "running", "provisioning", "failed", "stopped", "unassigned"];

function filterLabel(filter: NodeQuickFilter, t: TFunction): string {
  if (filter === "all") return t("admin.v2.filter_all");
  if (filter === "unassigned") return t("admin.unassigned");
  if (filter === "failed") return t("admin.v2.filter_failed");
  // NOT status.running. This slice is "the Computer process is up" — see
  // matchesNodeQuickFilter — which makes it a SUPERSET of Ready, so labelling
  // it "Running" put two pills reading `Ready 3 · Running 3` side by side in a
  // row that looks like a partition, and collided with the dashboard's
  // Running tile, where the same word counts computers executing an agent
  // right now. The predicate is deliberate and tested; the word was wrong.
  if (filter === "running") return t("admin.v2.filter_running");
  return t(`status.${filter}`, { defaultValue: filter });
}

/* Work in flight takes `live`, which is what --live is scoped to; everything
   else defers to `statusTone`, so the band cannot disagree with the pill the
   same status wears on a card. */
function nodeBandTone(status: string): StateTone {
  if (status === "running" || status === "busy") return "live";
  return statusTone(status);
}

/** The column header row, repeated once per band — see `EmployeeCols`. */
function NodeCols({
  sort,
  onSort,
  t,
}: {
  sort: SortState<NodeSortKey> | null;
  onSort: (key: NodeSortKey) => void;
  t: TFunction;
}) {
  return (
    <TableRow className="adm-node-cols">
      <SortableColumnHeader
        className="adm-col-label"
        label={t("admin.v2.col_node")}
        sortKey="node"
        sort={sort}
        onSort={onSort}
      />
      <SortableColumnHeader
        className="adm-col-label"
        label={t("admin.v2.col_employee")}
        sortKey="employee"
        sort={sort}
        onSort={onSort}
      />
      <SortableColumnHeader
        className="adm-col-label"
        label={t("admin.v2.node_runtimes")}
        sortKey="runtimes"
        sort={sort}
        onSort={onSort}
        defaultDirection="desc"
      />
      {/* Actions is not a column of data — there is nothing to order by. */}
      <TableHead className="adm-col-label adm-col-label--metrics">{t("admin.v2.col_actions")}</TableHead>
    </TableRow>
  );
}

export function NodesView({ nodes, employees, storedTokens, layout, onLayoutChange, onRevealCredentials, onRenameNode, onManageExecutors, onDeleteNode, onAddNode, highlightedNodeId }: NodesViewProps) {
  const { t } = useTranslation();
  const [filter, setFilter] = useState<NodeQuickFilter>("all");
  const [query, setQuery] = useState("");
  const colocated = canUseLocalControlPanel();

  const employeeById = useMemo(() => {
    const map = new Map<string, EmployeeRecord>();
    for (const employee of employees) map.set(employee.id, employee);
    return map;
  }, [employees]);

  const counts = useMemo(() => {
    const result: Record<NodeQuickFilter, number> = {
      all: nodes.length,
      ready: 0,
      running: 0,
      provisioning: 0,
      failed: 0,
      stopped: 0,
      unassigned: 0,
    };
    for (const node of nodes) {
      if (matchesNodeQuickFilter(node, "ready")) result.ready += 1;
      if (matchesNodeQuickFilter(node, "running")) result.running += 1;
      if (matchesNodeQuickFilter(node, "provisioning")) result.provisioning += 1;
      if (matchesNodeQuickFilter(node, "failed")) result.failed += 1;
      if (matchesNodeQuickFilter(node, "stopped")) result.stopped += 1;
      if (!node.employeeId) result.unassigned += 1;
    }
    return result;
  }, [nodes]);

  const sortColumns = useMemo(() => nodeSortColumns(employeeById), [employeeById]);
  // A distinct param: the admin page keeps Nodes and Employees on one route,
  // so a bare `sort` would have the two tables fighting over one key.
  const { sort, toggleSort, setSort } = useListSort(sortColumns, "nodeSort");
  const { page, setPage } = usePagination("nodePage");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matching = stableNodeOrder(nodes).filter((node) => {
      if (!matchesNodeQuickFilter(node, filter)) return false;
      if (!q) return true;
      const employee = (node.employeeId && employeeById.get(node.employeeId)) ?? null;
      const employeeName = employee ? `${employee.displayName} ${employee.id}`.toLowerCase() : "";
      const haystack = [
        node.id,
        node.displayName ?? "",
        node.workspacePath ?? "",
        node.sandboxMode ?? "",
        ...Object.keys(node.agents),
        employeeName,
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(q);
    });
    // Unsorted, `stableNodeOrder` above still decides — applySort is identity.
    return applySort(matching, sortColumns, sort);
  }, [nodes, filter, query, employeeById, sort, sortColumns]);

  // One cursor for both layouts: switching card/list keeps the reader on the
  // same machines rather than resetting them to the top of the fleet.
  const paged = paginate(filtered, page);
  const groups = useMemo(() => nodesByStatus(filtered), [filtered]);
  /* The lane order is the statuses actually ON SCREEN, not NODE_STATUS_ORDER:
     a status this build has never heard of still gets a band, and a band
     whose name the hook does not recognise cannot persist its cursor —
     `serializeLanePages` filters to the order it was given. */
  const groupStatuses = useMemo(() => groups.map((group) => group.status), [groups]);
  const { lanePages: groupPages, setLanePage: setGroupPage } = useLanePagination(groupStatuses, "nodeLanes");
  /* Keyed by status STRING rather than a fixed record: the backend can name
     a status this build has never heard of, and `nodesByStatus` still bands
     it. A cursor for a band that is not on screen is simply never read. */
  const pagedGroups = useMemo(
    () => Object.fromEntries(groups.map(({ status, nodes: groupNodes }) => [
      status,
      paginate(groupNodes, groupPages[status] ?? 1, LANE_PAGE_SIZE),
    ])),
    [groups, groupPages],
  );

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
                  { key: "node", label: t("admin.v2.col_node") },
                  { key: "employee", label: t("admin.v2.col_employee") },
                  { key: "runtimes", label: t("admin.v2.node_runtimes"), defaultDirection: "desc" as const },
        ]}
          sort={sort}
          onSortChange={setSort}
          label={t("admin.v2.nav_nodes")}
        />
        <AdminLayoutToggle layout={layout} onChange={onLayoutChange} />
      </div>

      <SearchInput
        className="relay-search adm-search"
        inputClassName="adm-search-input"
        label={t("admin.v2.search_nodes_placeholder")}
        name="admin-nodes-search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder={t("admin.v2.search_nodes_placeholder")}
      />

      {filtered.length === 0 ? (
        <RelayEmptyState
          className="adm-fleet-empty"
          fill
          title={nodes.length === 0 ? t("admin.no_nodes") : t("admin.v2.no_nodes_for_filter")}
          illustration={<AdminNode size={ICON.hero} strokeWidth={ICON_STROKE_LARGE} aria-hidden="true" />}
          actions={nodes.length === 0 && onAddNode ? (
            <Button type="button" onClick={onAddNode}>
              {t("admin.v2.add_node_cta")}
            </Button>
          ) : undefined}
        />
      ) : layout === "card" ? (
        <div className="adm-fleet-grid">
          {paged.items.map((node) => {
            const employee = node.employeeId ? employeeById.get(node.employeeId) : undefined;
            const employeeName = employee?.displayName;
            return (
              <NodeCard
                key={node.id}
                node={node}
                employeeName={employeeName}
                storedTokens={storedTokens}
                colocated={colocated}
                onReveal={onRevealCredentials}
                onRename={onRenameNode}
                onManageExecutors={onManageExecutors}
                onDelete={onDeleteNode}
                highlight={node.id === highlightedNodeId}
                t={t}
              />
            );
          })}
        </div>
      ) : (
        /* Grouped by fleet lifecycle. NOT by the quick-filter chips above:
           those slices overlap on purpose (`running` is a superset of
           `ready`), so they cannot partition a list — `visualStatus` can,
           and that is what `nodesByStatus` bands on. */
        <div className="adm-grouped-list">
          {groups.map(({ status, nodes: groupNodes }) => {
            const label = t(`status.${status}`, { defaultValue: status });
            const groupPage = pagedGroups[status];
            return (
              <ListGroup
                key={status}
                label={label}
                count={groupNodes.length}
                tone={nodeBandTone(status)}
              >
                <Table className="list-group-rows" data-density="compact" aria-label={label}>
                  <NodeCols sort={sort} onSort={toggleSort} t={t} />
                  <TableRowGroup className="adm-node-list" render={<ul />}>
                    {groupPage.items.map((node) => {
                      const employee = node.employeeId ? employeeById.get(node.employeeId) : undefined;
                      return (
                        <NodeRow
                          key={node.id}
                          node={node}
                          employeeName={employee?.displayName}
                          storedTokens={storedTokens}
                          colocated={colocated}
                          onReveal={onRevealCredentials}
                          onRename={onRenameNode}
                          onManageExecutors={onManageExecutors}
                          onDelete={onDeleteNode}
                          highlight={node.id === highlightedNodeId}
                          t={t}
                        />
                      );
                    })}
                  </TableRowGroup>
                </Table>
                <Pagination
                  compact
                  className="list-group-pager"
                  page={groupPage}
                  onPageChange={(next) => setGroupPage(status, next)}
                  label={label}
                />
              </ListGroup>
            );
          })}
        </div>
      )}

      {/* The CARD layout is a flat grid and pages off one cursor; the list
          groups, so it pages per band. Same split as the employee list. */}
      {layout === "card" ? (
        <Pagination page={paged} onPageChange={setPage} label={t("admin.v2.nav_nodes")} />
      ) : null}
    </div>
  );
}
