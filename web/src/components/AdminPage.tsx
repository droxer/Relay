"use client";

import { memo, useEffect, useEffectEvent, useMemo, useState } from "react";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { DashboardView } from "./admin/dashboard/DashboardView";
import { useNodeMetrics } from "../hooks/useNodeMetrics";
import { useTranslation } from "react-i18next";
import { handleForUserId } from "../lib/userHandle";
import { StateMark } from "./StateMark";
import { useMutationError } from "../hooks/useMutationError";
import { Button } from "@/components/ui/button";
import {
  AdminInvite,
  ICON,
} from "./icons";
import { getOrgSettings, deleteControlPanelDaemonNode, deleteControlPanelUser, deleteManagedNode, getAuthStatus, getMe, listManagedNodes, permanentlyDeleteManagedNode, recoverManagedNode, RelayApiError, unassignControlPanelDaemonNode, updateComputerDisplayName, updateControlPanelDaemonNodeDisabledAgents, updateManagedNodeDisplayName } from "../api";
import type {
  ControlPanelDaemonNodeRecord,
  CurrentUser,
  DaemonNodeMonitorRecord,
  WaitlistInviteResult,
  UserRecord,
  ManagedNodeRecord,
} from "../types";
import { AdminLoginScreen, FirstAdminSetupScreen } from "./admin/AdminAuthScreens";
import { CredentialsDrawer } from "./admin/CredentialsDrawer";
import { NodesView } from "./admin/NodesView";
import { ManageExecutorsDrawer } from "./admin/ManageExecutorsDrawer";
import { ManagedNodeHistory } from "./admin/ManagedNodeHistory";
import { PageHeader } from "./PageHeader";
import { isNodeOnline } from "../lib/adminHelpers";
import { PHONE_QUERY } from "./MobileTopbarSlot";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { AdminViewToggle, type AdminView } from "./admin/AdminViewToggle";
import { UsersView } from "./admin/UsersView";
import { EditUserDrawer } from "./admin/EditUserDrawer";
import { SettingsView } from "./admin/SettingsView";
import { WaitlistView } from "./admin/waitlist/WaitlistView";
import { InviteNextButton } from "./admin/waitlist/InviteNextButton";
import { InviteByEmailDrawer } from "./admin/waitlist/InviteByEmailDrawer";
import type { AdminLayout } from "./admin/AdminLayoutToggle";
import { useAdminNodes } from "../hooks/useAdminNodes";
import { useAdminUsers } from "../hooks/useAdminUsers";
import { NODES_QUERY_KEY } from "../hooks/useRelayData";
import { withoutDeletedComputer } from "../lib/daemonNodes";
import { useRelayStore } from "../lib/store";
import { ADMIN_ROSTER_POLL_MS, ADMIN_USERS_KEY, CONTROL_PANEL_NODES_KEY } from "../lib/controlPanelQueries";
import { useDialogs } from "@/components/ui/DialogProvider";
import {
  persistStoredNodeTokenMap,
  readStoredNodeTokens,
  upsertStoredCredentialsFromNodes,
  type StoredNodeTokenMap,
} from "./admin/helpers";
import { omit } from "../lib/omit";
import { useKeyChange } from "../hooks/useKeyChange";

type AuthScreen = "login" | "bootstrap";
const NO_USERS: UserRecord[] = [];
const NO_NODES: ControlPanelDaemonNodeRecord[] = [];

type AdminPageProps = {
  currentUser?: CurrentUser | null;
  /** The open section, read from the path (`/admin/<section>`). The control
      panel's sections are destinations, so the address bar owns which one is
      open — a reload or a shared link lands on the same one. */
  section: AdminView;
  onSelectSection: (section: AdminView) => void;
};

/** What one auth round-trip learned. `requiresBootstrap` is null when the
 *  status call failed; `admin` is undefined when the identity call was aborted,
 *  so there is no answer to apply. */
interface AuthProbe {
  requiresBootstrap: boolean | null;
  admin: CurrentUser | null | undefined;
  adminTokenRequired: boolean;
}

async function probeAuth(signal?: AbortSignal): Promise<AuthProbe> {
  let requiresBootstrap: boolean | null = null;
  try {
    requiresBootstrap = (await getAuthStatus(signal)).requiresBootstrap;
  } catch {
    // Unknown: leave the screen where it is.
  }
  try {
    const result = await getMe(signal);
    const admin = result.authenticated && result.user?.role === "admin" ? result.user : null;
    return { requiresBootstrap, admin, adminTokenRequired: false };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return { requiresBootstrap, admin: undefined, adminTokenRequired: false };
    }
    const status = err && typeof err === "object" && "status" in err ? (err as { status: number }).status : 0;
    return { requiresBootstrap, admin: null, adminTokenRequired: status === 503 };
  }
}

function AdminPageView({ currentUser, section, onSelectSection }: AdminPageProps) {
  const { t } = useTranslation();
  const { prompt } = useDialogs();
  const { reportMutationError } = useMutationError();
  const queryClient = useQueryClient();

  // App only mounts this component for an authenticated admin, so seed the auth
  // state from the session it already holds. This skips the redundant /auth/me
  // probe on mount that would otherwise flash the admin login/loading card
  // before resolving.
  const seededAdmin = currentUser?.role === "admin" ? currentUser : null;
  const [admin, setAdmin] = useState<CurrentUser | null>(seededAdmin);
  const [authChecked, setAuthChecked] = useState(seededAdmin !== null);
  const [needsBootstrap, setNeedsBootstrap] = useState(false);
  const [authScreen, setAuthScreen] = useState<AuthScreen>("login");
  const [authError, setAuthError] = useState<string | null>(null);

  const view = section;
  const usersSection = view === "users" || view === "waitlist";
  const setView = onSelectSection;
  const [layout, setLayout] = useState<AdminLayout>("card");
  /* A phone has no width for the table: it always gets the cards, and the
     card/list switch is hidden there (admin-v2-users.css). */
  const phone = useMediaQuery(PHONE_QUERY);
  const shownLayout: AdminLayout = phone ? "card" : layout;
  const directory = useAdminUsers({ enabled: Boolean(admin) && view === "users", live: view === "users" });
  const users = directory.response?.users ?? NO_USERS;
  const pagedRoster = directory.response?.page !== undefined;
  const { nodes, mergeNodes, refetch, inventoryLoading, inventoryError } = useAdminNodes({
    enabled: Boolean(admin) && (view === "dashboard" || view === "computers"
      || (view === "users" && directory.response !== undefined && !pagedRoster)),
    live: view === "dashboard" || view === "computers" || view === "users",
  });
  const pollError = inventoryError ?? (view === "users" && directory.error ? directory.error.message : null);
  const managedNodesQuery = useInfiniteQuery({
    queryKey: ["admin", "managed-nodes"],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ signal, pageParam }) => listManagedNodes(signal, pageParam),
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    enabled: Boolean(admin) && view === "computers",
    staleTime: ADMIN_ROSTER_POLL_MS,
    // Older pages are historical. Keep a slow head poll while only it is loaded.
    refetchInterval: ({ state }) => (state.data?.pages.length ?? 0) < 2 ? ADMIN_ROSTER_POLL_MS : false,
    refetchOnMount: ({ state }) => (state.data?.pages.length ?? 0) < 2,
  });
  const managedNodes = useMemo(() => managedNodesQuery.data?.pages.flatMap(page => page.nodes) ?? [], [managedNodesQuery.data]);
  const computerOwners = useMemo(() => {
    const owners = new Map<string, UserRecord>();
    for (const node of [...managedNodes, ...nodes]) {
      if (node.ownerLabel) owners.set(node.ownerLabel.id, node.ownerLabel);
    }
    for (const user of users) owners.set(user.id, user);
    return [...owners.values()];
  }, [users, nodes, managedNodes]);
  // The org default is what a user without an override follows, so the
  // user forms show it as their placeholder.
  const orgSettingsQuery = useQuery({
    queryKey: ["admin", "settings"],
    queryFn: ({ signal }) => getOrgSettings(signal),
    enabled: Boolean(admin) && usersSection,
  });
  const defaultMaxLocalComputers = orgSettingsQuery.data?.settings.maxLocalComputersPerUser;
  // Absent while the query is in flight; only a definite false hides the
  // controls, so a slow answer does not flash them away.
  const canEditUsers = orgSettingsQuery.data?.capabilities?.userEdits !== false;
  // Users always includes invitations. Public signup renames that tab to
  // Waitlist and enables "Invite next"; capabilities default off while loading.
  const waitlistOpen = orgSettingsQuery.data?.capabilities?.waitlist === true;
  const canEmailInvites = orgSettingsQuery.data?.capabilities?.inviteEmail === true;
  const [inviteEmailOpen, setInviteEmailOpen] = useState(false);
  /** Invite links minted this visit. Only their hashes are stored, so this is
      the one place they can still be read; dismissing or leaving drops them. */
  const [waitlistInvites, setWaitlistInvites] = useState<WaitlistInviteResult[] | null>(null);
  const setAdminView = useRelayStore((state) => state.setAdminView);
  const [editingUser, setEditingUser] = useState<UserRecord | null>(null);
  const [credentialsNodeId, setCredentialsNodeId] = useState<string | null>(null);
  const [manageExecutorsNodeId, setManageExecutorsNodeId] = useState<string | null>(null);
  const [storedTokens, setStoredTokens] = useState<StoredNodeTokenMap>(() => readStoredNodeTokens());

  function applyAuthProbe(probe: AuthProbe) {
    setNeedsBootstrap(probe.requiresBootstrap ?? false);
    if (probe.requiresBootstrap !== null) setAuthScreen(probe.requiresBootstrap ? "bootstrap" : "login");
    if (probe.admin !== undefined) setAdmin(probe.admin);
    if (probe.adminTokenRequired) setAuthError(t("admin.admin_token_required"));
    setAuthChecked(true);
  }

  function checkAuth(signal?: AbortSignal) {
    return probeAuth(signal).then(applyAuthProbe);
  }

  // A seeded admin already passed the check upstream; read at mount only.
  const probeOnMount = useEffectEvent(() => !seededAdmin);
  const applyMountProbe = useEffectEvent(applyAuthProbe);

  useEffect(() => {
    if (!probeOnMount()) return;
    const controller = new AbortController();
    void probeAuth(controller.signal).then(applyMountProbe);
    return () => controller.abort();
  }, []);

  // The node poll lives in useAdminNodes; a failure that looks like an expired
  // session drops us back to the login screen (the query disables once admin
  // clears).
  useKeyChange(pollError, (error) => {
    if (error && (error.includes("401") || error.includes("Session expired") || error.includes("Admin token is required"))) {
      setAdmin(null);
    }
  }, { from: null });

  useEffect(() => {
    setAdminView(view);
  }, [setAdminView, view]);

  const metrics = useNodeMetrics(nodes, users);

  const credentialsNode = useMemo(
    () => (credentialsNodeId ? nodes.find((node) => node.id === credentialsNodeId) ?? null : null),
    [credentialsNodeId, nodes],
  );
  const manageExecutorsNode = useMemo(
    () => (manageExecutorsNodeId ? nodes.find((node) => node.id === manageExecutorsNodeId) ?? null : null),
    [manageExecutorsNodeId, nodes],
  );

  // Credentials the node poll returns are folded into the stored map as they
  // arrive; writing the merged map back to storage is the effect's half.
  const [mergedTokens, setMergedTokens] = useState<StoredNodeTokenMap | null>(null);
  useKeyChange(nodes, (next) => {
    const updated = upsertStoredCredentialsFromNodes(storedTokens, next);
    if (!updated) return;
    setStoredTokens(updated);
    setMergedTokens(updated);
  }, { from: [] });
  useEffect(() => {
    if (mergedTokens) persistStoredNodeTokenMap(mergedTokens);
  }, [mergedTokens]);

  function handleRevealCredentials(node: ControlPanelDaemonNodeRecord) {
    setCredentialsNodeId(node.id);
  }

  function handleManageExecutors(node: ControlPanelDaemonNodeRecord) {
    setManageExecutorsNodeId(node.id);
  }

  function handleNodeUpdated(updated: ControlPanelDaemonNodeRecord) {
    mergeNodes((prev) => prev.map((current) => (current.id !== updated.id ? current : {
        ...updated,
        ownerLabel: updated.ownerLabel ?? (updated.userId === current.userId ? current.ownerLabel : undefined),
    })));
  }

  async function handleRenameNode(node: ControlPanelDaemonNodeRecord) {
    const current = node.displayName?.trim() && node.displayName !== node.id
      ? node.displayName.trim()
      : "";
    const result = await prompt({
      title: t("thread.rename_computer"),
      message: t("thread.rename_computer_message", { id: node.id }),
      defaultValue: current,
      placeholder: t("thread.computer_name_placeholder"),
      confirmLabel: t("thread.rename"),
    });
    if (result === null) return;
    const displayName = result.trim();
    if (displayName === current) return;
    try {
      if (node.managedNodeId) {
        const updated = await updateManagedNodeDisplayName(
          node.managedNodeId,
          displayName || null,
        );
        handleNodeUpdated({
          ...node,
          displayName: updated.node.displayName || node.id,
        });
      } else {
        const updated = await updateComputerDisplayName(
          node.id,
          displayName || null,
        );
        handleNodeUpdated({ ...node, ...updated.node });
      }
    } catch (error) {
      reportMutationError(
        "Failed to rename computer",
        error,
        t("errors.rename_computer"),
      );
    }
  }

  async function handleUnassignNode(node: ControlPanelDaemonNodeRecord) {
    try {
      const result = await unassignControlPanelDaemonNode(node.id);
      mergeNodes((prev) => prev.map((current) => (current.id === result.node.id ? result.node : current)));
    } catch (error) {
      reportMutationError("Failed to unassign node", error, t("errors.admin_unassign_node"));
      throw error;
    }
  }

  async function handleDeleteNode(node: ControlPanelDaemonNodeRecord) {
    try {
      if (node.managedNodeId) {
        try {
          await deleteManagedNode(node.managedNodeId);
        } catch (error) {
          if (error instanceof RelayApiError && error.status === 404) {
            await deleteControlPanelDaemonNode(node.id);
          } else {
            throw error;
          }
        }
      } else {
        await deleteControlPanelDaemonNode(node.id);
      }
      mergeNodes((prev) => prev.filter((current) => (
          node.managedNodeId
            ? current.managedNodeId !== node.managedNodeId && current.id !== node.id
            : current.id !== node.id
      )));
      await queryClient.cancelQueries({ queryKey: NODES_QUERY_KEY, exact: true });
      queryClient.setQueryData<DaemonNodeMonitorRecord[]>(NODES_QUERY_KEY, (current) =>
        withoutDeletedComputer(current ?? [], node));
      void queryClient.invalidateQueries({ queryKey: NODES_QUERY_KEY, exact: true });
      setCredentialsNodeId(null);
    } catch (error) {
      reportMutationError("Failed to delete node", error, t("errors.admin_delete_node"));
      throw error;
    }
  }

  async function handleRecoverManagedNode(node: ManagedNodeRecord) {
    try {
      await recoverManagedNode(node.id);
      await Promise.all([managedNodesQuery.refetch(), refetch()]);
    } catch (error) {
      reportMutationError("Failed to recover managed node", error, t("errors.admin_recover_node"));
      throw error;
    }
  }

  async function handlePermanentlyDeleteManagedNode(node: ManagedNodeRecord) {
    try {
      await permanentlyDeleteManagedNode(node.id);
      await Promise.all([managedNodesQuery.refetch(), refetch()]);
    } catch (error) {
      reportMutationError("Failed to permanently delete managed-node record", error, t("errors.admin_delete_node"));
      throw error;
    }
  }

  async function handleDeleteUser(user: UserRecord) {
    try {
      const result = await deleteControlPanelUser(user.id);
      const unassignedSet = new Set(result.unassignedNodes);
      mergeNodes((prev) => prev.map((current) =>
        unassignedSet.has(current.id) ? omit(current, "userId", "ownerLabel") : current,
      ));
      await queryClient.invalidateQueries({ queryKey: ADMIN_USERS_KEY });
    } catch (error) {
      reportMutationError("Failed to delete user", error, t("errors.admin_delete_user"));
      throw error;
    }
  }

  function handleEditUserSuccess() {
    setEditingUser(null);
    void queryClient.invalidateQueries({ queryKey: ADMIN_USERS_KEY });
    void queryClient.invalidateQueries({ queryKey: CONTROL_PANEL_NODES_KEY, refetchType: "none" });
  }

  if (!authChecked) {
    return (
      <section className="admin-console adm-bare">
        <div className="route-loading" role="status" aria-live="polite">{t("admin.loading")}</div>
      </section>
    );
  }

  if (!admin) {
    return (
      <section className="admin-console adm-bare">
        {authScreen === "bootstrap" || needsBootstrap ? (
          <FirstAdminSetupScreen onBootstrapped={() => void checkAuth()} onSwitchToLogin={() => setAuthScreen("login")} />
        ) : (
          <AdminLoginScreen
            onLogin={() => void checkAuth()}
            needsBootstrap={needsBootstrap}
            onSwitchToBootstrap={() => setAuthScreen("bootstrap")}
          />
        )}
      </section>
    );
  }

  const managedNodesError = view === "computers" && managedNodesQuery.error instanceof Error
    ? managedNodesQuery.error.message
    : view === "computers" && managedNodesQuery.error
      ? String(managedNodesQuery.error)
      : null;
  const headerError = authError ?? pollError ?? managedNodesError;
  const viewTitle = view === "waitlist"
    ? t(waitlistOpen ? "admin.v2.title_waitlist" : "admin.v2.nav_invitations")
    : t(`admin.v2.title_${view}`);
  const hasHeaderActions = Boolean(headerError) || usersSection;
  const headerCount = view === "users"
    ? directory.loading ? undefined : t("admin.user_count", { count: directory.response?.userCount ?? users.length })
    : view === "computers"
      // The owner's page counts "4 computers · 3 online"; the fleet reads the
      // same way.
      ? nodes.length > 0
        ? `${t("admin.node_count", { count: nodes.length })} · ${t("computer.online_count", { count: nodes.filter(isNodeOnline).length })}`
        : t("admin.node_count", { count: nodes.length })
      : undefined;

  return (
    <section
      id="admin-panel"
      className="admin-console sec-shell"
      data-admin-view={view}
      aria-label={viewTitle}
      tabIndex={-1}
    >
      <div className="sec-rail">
        {/* Title alone, like every other list rail in the app (threads,
            agents, teams, projects). A kicker above it restated where the
            side navigation had already put the reader. */}
        <PageHeader
          title={t("admin.control_panel.title")}
          titleAs="h2"
          titleVariant="title"
          layout="stacked"
        />
        <AdminViewToggle view={view} waitlistOpen={waitlistOpen} onChange={setView} />
      </div>

      <div className="sec-main">
        <PageHeader
          title={viewTitle}
          titleAs="h2"
          titleVariant="title"
          count={headerCount}
          topbarActions
          actions={hasHeaderActions ? (
            <>
              {headerError ? (
                <span
                  className="adm-command-status"
                  role="status"
                  aria-live="polite"
                  aria-atomic="true"
                >
                  <StateMark tone="bad" />
                  <span className="adm-command-status-text text-danger">
                    {t("admin.fetch_error", { message: headerError })}
                  </span>
                </span>
              ) : null}
              {view === "waitlist" && waitlistOpen ? (
                <InviteNextButton onInvited={(results) => setWaitlistInvites(results)} />
              ) : null}
              {usersSection ? (
                <Button
                  type="button"
                  className="adm-create-action"
                  onClick={() => setInviteEmailOpen(true)}
                  aria-label={t(canEmailInvites ? "admin.waitlist.invite_email_cta" : "admin.waitlist.invite_link_cta")}
                  tooltip={t(canEmailInvites ? "admin.waitlist.invite_email_cta" : "admin.waitlist.invite_link_cta")}
                >
                  <AdminInvite size={ICON.md} aria-hidden="true" />
                  <span className="adm-create-action-label">
                    {t(canEmailInvites ? "admin.waitlist.invite_email_cta" : "admin.waitlist.invite_link_cta")}
                  </span>
                </Button>
              ) : null}
            </>
          ) : undefined}
        />

        <div className="adm-content">
          <div className="adm-content-main">
            <div key={view} className="adm-view-stage">
              {view === "dashboard" ? (
                <DashboardView
                  nodes={nodes} metrics={metrics}
                  inventoryLoading={inventoryLoading} inventoryError={inventoryError}
                  onManageNodes={() => setView("computers")}
                />
              ) : view === "users" ? (
                <UsersView
                  directory={directory}
                  users={users}
                  nodes={pagedRoster ? directory.response?.nodes ?? NO_NODES : nodes}
                  layout={shownLayout}
                  onLayoutChange={setLayout}
                  onDeleteUser={handleDeleteUser}
                  onEditUser={canEditUsers ? setEditingUser : undefined}
                  highlightedUserId={null}
                />
              ) : view === "organization" ? (
                <SettingsView />
              ) : view === "waitlist" ? (
                <WaitlistView
                  waitlistOpen={waitlistOpen}
                  invites={waitlistInvites}
                  onInvited={(results) => setWaitlistInvites(results)}
                  onDismissInvites={() => setWaitlistInvites(null)}
                />
              ) : (
                <>
                  <NodesView
                    nodes={nodes}
                    users={computerOwners}
                    layout={shownLayout}
                    onLayoutChange={setLayout}
                    onRevealCredentials={handleRevealCredentials}
                    onRenameNode={(node) => void handleRenameNode(node)}
                    onManageExecutors={handleManageExecutors}
                    onDeleteNode={handleDeleteNode}
                    highlightedNodeId={null}
                  />
                  <ManagedNodeHistory
                    nodes={managedNodes}
                    users={computerOwners}
                    loadingMore={managedNodesQuery.isFetchingNextPage}
                    onLoadMore={managedNodesQuery.hasNextPage
                      ? () => { void managedNodesQuery.fetchNextPage(); }
                      : undefined}
                    onRecover={handleRecoverManagedNode}
                    onDeletePermanently={handlePermanentlyDeleteManagedNode}
                  />
                </>
              )}
            </div>
          </div>
        </div>
      </div>

      <InviteByEmailDrawer
        open={inviteEmailOpen}
        onClose={() => setInviteEmailOpen(false)}
        canEmail={canEmailInvites}
        onInvited={(results) => {
          setWaitlistInvites(results);
          setView("waitlist");
        }}
      />
      <EditUserDrawer
        open={editingUser !== null}
        onClose={() => setEditingUser(null)}
        user={editingUser}
        defaultMaxLocalComputers={defaultMaxLocalComputers}
        onSuccess={handleEditUserSuccess}
      />
      <CredentialsDrawer
        open={credentialsNodeId !== null}
        onClose={() => setCredentialsNodeId(null)}
        node={credentialsNode}
        storedToken={credentialsNodeId ? storedTokens[credentialsNodeId] : undefined}
        userHandle={handleForUserId(computerOwners, credentialsNode?.userId)}
        onUnassign={handleUnassignNode}
        onDelete={handleDeleteNode}
      />
      <ManageExecutorsDrawer
        open={manageExecutorsNodeId !== null}
        onClose={() => setManageExecutorsNodeId(null)}
        node={manageExecutorsNode}
        userHandle={handleForUserId(computerOwners, manageExecutorsNode?.userId)}
        onUpdated={handleNodeUpdated}
        onSave={updateControlPanelDaemonNodeDisabledAgents}
      />
    </section>
  );
}

// Memoized: the shell re-renders on every streamed frame of a run that may
// be on another route; the console polls its own data.
export const AdminPage = memo(AdminPageView);
