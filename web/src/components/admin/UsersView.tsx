"use client";

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import {
  AdminUsers,
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
import { userSortColumns } from "../../lib/adminHelpers";
import { UserGroupTable } from "./UserRow";
import {
  buildUserSummaries,
  userEmptyStateTranslationKey,
  usersByStatus,
  USER_SUMMARY_STATUS_ORDER,
  type UserSummaryStatusKey,
  matchesUserQuickFilter,
  type UserQuickFilter,
} from "./helpers";
import { UserCard } from "./UserCard";
import type { StateTone } from "../StateMark";
import { AdminLayoutToggle, type AdminLayout } from "./AdminLayoutToggle";
import { Alert } from "@/components/ui/alert";

interface UsersViewProps {
  users: import("../../types").UserRecord[];
  nodes: ControlPanelDaemonNodeRecord[];
  layout: AdminLayout;
  onLayoutChange: (next: AdminLayout) => void;
  onAddUser: () => void;
  onDeleteUser?: (user: import("../../types").UserRecord) => Promise<void>;
  onEditUser?: (user: import("../../types").UserRecord) => void;
  highlightedUserId: string | null;
}

const FILTERS: UserQuickFilter[] = ["all", "running", "ready", "idle", "failed", "unassigned"];

/* The band's tone. `running` takes `live` rather than `info`: a band saying
   work is in flight right now is exactly what --live is scoped to, and it is
   the same reading the row's old pill carried through `live={tone==="info"}`.
   Everything else is `userSummaryStatus`'s own tone. */
const USER_STATUS_BAND_TONE: Record<UserSummaryStatusKey, StateTone> = {
  failed: "bad",
  running: "live",
  ready: "good",
  idle: "neutral",
  no_nodes: "neutral",
};

// User activity slices mirror the Nodes status chips (and the card status
// pill). running/ready/failed overlap by design — a user can own one
// running and one failed node — so counts are per-predicate membership, like
// the Nodes view. "idle" is the quiet remainder: has nodes, but none are
// running, ready, or failed (e.g. provisioning/stopped), so a broken node
// surfaces under "failed" instead of hiding as idle.
function filterLabel(filter: UserQuickFilter, t: TFunction): string {
  if (filter === "all") return t("admin.v2.filter_all");
  // "unassigned" here means the user owns no computer — distinct from the
  // Nodes view, where it means a node has no user. Use dedicated copy.
  if (filter === "unassigned") return t("admin.v2.emp_state_no_nodes");
  if (filter === "failed") return t("admin.v2.filter_failed");
  return t(`admin.v2.emp_state_${filter}`, { defaultValue: filter });
}

export function UsersView({
  users,
  nodes,
  layout,
  onLayoutChange,
  onAddUser,
  onDeleteUser,
  onEditUser,
  highlightedUserId,
}: UsersViewProps) {
  const { t } = useTranslation();
  const { confirm } = useDialogs();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<UserQuickFilter>("all");
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const usersById = useMemo(() => new Map(users.map((user) => [user.id, user])), [users]);

  async function handleDeleteUser(userId: string) {
    if (!onDeleteUser) return;
    const user = usersById.get(userId);
    if (!user) return;
    const ok = await confirm({
      title: t("admin.v2.delete_user_confirm", { name: user.displayName ?? user.id, id: user.id }),
      message: t("admin.v2.delete_user_message"),
      confirmLabel: t("admin.v2.delete_user_action"),
      tone: "danger",
    });
    if (!ok) return;
    setPendingDelete(userId);
    setDeleteError(null);
    try {
      await onDeleteUser(user);
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : String(error));
    } finally {
      setPendingDelete(null);
    }
  }

  const summaries = useMemo(() => buildUserSummaries(users, nodes), [users, nodes]);

  const counts = useMemo(() => {
    const result: Record<UserQuickFilter, number> = { all: summaries.length, running: 0, ready: 0, idle: 0, failed: 0, unassigned: 0 };
    for (const member of summaries) {
      if (matchesUserQuickFilter(member, "running")) result.running += 1;
      if (matchesUserQuickFilter(member, "ready")) result.ready += 1;
      if (matchesUserQuickFilter(member, "idle")) result.idle += 1;
      if (matchesUserQuickFilter(member, "failed")) result.failed += 1;
      if (matchesUserQuickFilter(member, "unassigned")) result.unassigned += 1;
    }
    return result;
  }, [summaries]);

  const sortColumns = useMemo(() => userSortColumns(), []);
  // A distinct param: the admin page keeps Users and Nodes on one route,
  // so a bare `sort` would have the two tables fighting over one key.
  const { sort, toggleSort, setSort } = useListSort(sortColumns, "userSort");
  const { page, setPage } = usePagination("userPage");
  const { lanePages: groupPages, setLanePage: setGroupPage } = useLanePagination(USER_SUMMARY_STATUS_ORDER, "userLanes");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matching = summaries.filter((item) => {
      if (!matchesUserQuickFilter(item, filter)) return false;
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
    // Unsorted, `buildUserSummaries`' id order stands — applySort is identity.
    return applySort(matching, sortColumns, sort);
  }, [summaries, query, filter, sort, sortColumns]);

  // One cursor for both layouts: switching card/list keeps the reader on the
  // same people rather than resetting them to the top of the roster.
  const paged = paginate(filtered, page);
  const grouped = useMemo(() => usersByStatus(filtered), [filtered]);
  const pagedGroups = useMemo(
    () => Object.fromEntries(USER_SUMMARY_STATUS_ORDER.map((key) => [
      key,
      paginate(grouped[key], groupPages[key] ?? 1, LANE_PAGE_SIZE),
    ])) as Record<UserSummaryStatusKey, ReturnType<typeof paginate<ReturnType<typeof buildUserSummaries>[number]>>>,
    [grouped, groupPages],
  );

  if (summaries.length === 0) {
    return (
      <RelayEmptyState
        className="adm-users-empty"
        fill
        title={t("admin.v2.empty_users_title")}
        body={t("admin.v2.empty_users_body")}
        illustration={<AdminUsers size={ICON.hero} strokeWidth={ICON_STROKE_LARGE} aria-hidden="true" />}
        actions={(
          <Button type="button" onClick={onAddUser}>
            {t("admin.v2.add_user_cta")}
          </Button>
        )}
      />
    );
  }

  return (
    <div className="adm-view">
      <div className="adm-view-controls">
        <div className="adm-fleet-filters" role="group" aria-label={t("admin.v2.filter_label")}>
          {/* A slice nobody is in is not a choice; All and the open one
              always stay so the row never loses its anchor. */}
          {FILTERS.filter((id) => id === "all" || id === filter || counts[id] > 0).map((id) => {
            const active = filter === id;
            return (
              <Button
                variant="ghost"
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
        <SearchInput
          className="relay-search adm-search"
          inputClassName="adm-search-input"
          label={t("admin.v2.search_users_placeholder")}
          name="admin-users-search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t("admin.v2.search_users_placeholder")}
        />
        {/* Sits with the layout toggle, not inside the filter chips: at the
            widths it appears, it is the only way to sort at all. */}
        <SortMenu
          options={[
                  { key: "user", label: t("admin.col_user") },
                  { key: "computers", label: t("admin.v2.col_computers"), defaultDirection: "desc" as const },
                  { key: "localLimit", label: t("admin.v2.col_local_limit"), defaultDirection: "desc" as const },
                  { key: "running", label: t("admin.v2.col_running"), defaultDirection: "desc" as const },
                  { key: "ready", label: t("admin.v2.col_ready"), defaultDirection: "desc" as const },
        ]}
          sort={sort}
          onSortChange={setSort}
          label={t("admin.v2.nav_users", { defaultValue: "Users" })}
        />
        <AdminLayoutToggle layout={layout} onChange={onLayoutChange} />
      </div>

      {deleteError ? (
        <Alert className="mb-4">{t("admin.v2.action_failed", { message: deleteError })}</Alert>
      ) : null}

      {filtered.length === 0 ? (
        <RelayEmptyState
          className="adm-users-empty"
          fill
          title={t(userEmptyStateTranslationKey(query, filter))}
        />
      ) : layout === "card" ? (
        <div className="adm-fleet-grid">
          {paged.items.map((member) => (
            <UserCard
              key={member.id}
              member={member}
              highlight={highlightedUserId === member.id}
              onDelete={onDeleteUser ? (id) => void handleDeleteUser(id) : undefined}
              onEdit={onEditUser ? (id) => {
                const user = usersById.get(id);
                if (user) onEditUser(user);
              } : undefined}
              deletePending={pendingDelete !== null}
              t={t}
            />
          ))}
        </div>
      ) : (
        /* Grouped by fleet health — the reason an admin opens this list. The
           per-row status pill went with it: the band is that pill, said once
           for the whole group instead of once per user. */
        <div className="adm-grouped-list">
          {USER_SUMMARY_STATUS_ORDER.map((key) => {
            const group = grouped[key];
            if (group.length === 0) return null;
            const label = t(`admin.v2.emp_state_${key}`, { defaultValue: key });
            const groupPage = pagedGroups[key];
            return (
              <ListGroup
                key={key}
                label={label}
                count={group.length}
                tone={USER_STATUS_BAND_TONE[key]}
              >
                <UserGroupTable
                  label={label}
                  members={groupPage.items}
                  sort={sort}
                  onSort={toggleSort}
                  highlightedId={highlightedUserId}
                  deletePending={pendingDelete !== null}
                  onEdit={onEditUser ? (id) => {
                    const user = usersById.get(id);
                    if (user) onEditUser(user);
                  } : undefined}
                  onDelete={onDeleteUser ? (id) => void handleDeleteUser(id) : undefined}
                />
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
        <Pagination page={paged} onPageChange={setPage} label={t("admin.v2.nav_users", { defaultValue: "Users" })} />
      ) : null}
    </div>
  );
}
