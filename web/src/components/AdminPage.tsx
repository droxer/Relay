"use client";

import { useEffect, useEffectEvent, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { DashboardView } from "./admin/dashboard/DashboardView";
import { useNodeMetrics } from "../hooks/useNodeMetrics";
import { useTranslation } from "react-i18next";
import { handleForUserId } from "../lib/userHandle";
import { StateMark } from "./StateMark";
import { useMutationError } from "../hooks/useMutationError";
import { Button } from "@/components/ui/button";
import {
  ActionAdd,
  ICON,
} from "./icons";
import { getOrgSettings, deleteControlPanelDaemonNode, deleteControlPanelUser, deleteManagedNode, getAuthStatus, getMe, listManagedNodes, permanentlyDeleteManagedNode, recoverManagedNode, RelayApiError, unassignControlPanelDaemonNode, updateComputerDisplayName, updateControlPanelDaemonNodeDisabledAgents, updateManagedNodeDisplayName } from "../api";
import type {
  AssignControlPanelDaemonNodeResponse,
  ControlPanelDaemonNodeRecord,
  CreateManagedNodeResponse,
  CreateControlPanelDaemonNodeResponse,
  CreateControlPanelUserResponse,
  CurrentUser,
  DaemonNodeMonitorRecord,
  WaitlistInviteResult,
  UserRecord,
  ManagedNodeRecord,
} from "../types";
import { AssignNodeDrawer } from "./admin/AssignNodeDrawer";
import { AdminLoginScreen, FirstAdminSetupScreen } from "./admin/AdminAuthScreens";
import { CredentialsDrawer } from "./admin/CredentialsDrawer";
import { NodesView } from "./admin/NodesView";
import { ManageExecutorsDrawer } from "./admin/ManageExecutorsDrawer";
import { ManagedNodeHistory } from "./admin/ManagedNodeHistory";
import { PageHeader } from "./PageHeader";
import { AdminViewToggle, type AdminView } from "./admin/AdminViewToggle";
import { AddUserDrawer } from "./admin/AddUserDrawer";
import { AddNodeDrawer, type AddNodeDrawerSuccess } from "./admin/AddNodeDrawer";
import { UsersView } from "./admin/UsersView";
import { EditUserDrawer } from "./admin/EditUserDrawer";
import { SettingsView } from "./admin/SettingsView";
import { WaitlistView } from "./admin/waitlist/WaitlistView";
import { InviteNextButton } from "./admin/waitlist/InviteNextButton";
import { RelayEmptyState } from "./RelayEmptyState";
import type { AdminLayout } from "./admin/AdminLayoutToggle";
import { useAdminNodes } from "../hooks/useAdminNodes";
import { NODES_QUERY_KEY } from "../hooks/useRelayData";
import { withoutDeletedComputer } from "../lib/daemonNodes";
import { useRelayStore } from "../lib/store";
import { CONTROL_PANEL_POLL_MS } from "../lib/controlPanelQueries";
import { useDialogs } from "@/components/ui/DialogProvider";
import {
  HIGHLIGHT_PULSE_MS,
  persistStoredNodeTokenMap,
  readStoredNodeTokens,
  upsertStoredCredentialsFromNodes,
  writeStoredNodeToken,
  type StoredNodeTokenMap,
} from "./admin/helpers";
import { Alert } from "@/components/ui/alert";
import { omit } from "../lib/omit";
import { useKeyChange } from "../hooks/useKeyChange";

type AuthScreen = "login" | "bootstrap";

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

export function AdminPage({ currentUser, section, onSelectSection }: AdminPageProps) {
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
  const setView = onSelectSection;
  const [layout, setLayout] = useState<AdminLayout>("card");
  const { nodes, users, pollError, mergeNodes, refetch } = useAdminNodes(
    Boolean(admin),
    view === "dashboard" || layout === "list",
  );
  const managedNodesQuery = useQuery({
    queryKey: ["admin", "managed-nodes"],
    queryFn: ({ signal }) => listManagedNodes(signal),
    enabled: Boolean(admin) && view === "computers",
    refetchInterval: CONTROL_PANEL_POLL_MS,
  });
  const managedNodes = managedNodesQuery.data?.nodes ?? [];
  // The org default is what a user without an override follows, so the
  // user forms show it as their placeholder.
  const orgSettingsQuery = useQuery({
    queryKey: ["admin", "settings"],
    queryFn: ({ signal }) => getOrgSettings(signal),
    enabled: Boolean(admin),
  });
  const defaultMaxLocalComputers = orgSettingsQuery.data?.settings.maxLocalComputersPerUser;
  // Absent while the query is in flight; only a definite false hides the
  // controls, so a slow answer does not flash them away.
  const canEditUsers = orgSettingsQuery.data?.capabilities?.userEdits !== false;
  // The opposite default: the waitlist is off unless the server says its
  // routes are mounted, so the rail never offers a section that would 404.
  const waitlistAvailable = orgSettingsQuery.data?.capabilities?.waitlist === true;
  /** Invite links minted this visit. Only their hashes are stored, so this is
      the one place they can still be read; dismissing or leaving drops them. */
  const [waitlistInvites, setWaitlistInvites] = useState<WaitlistInviteResult[] | null>(null);
  const setAdminView = useRelayStore((state) => state.setAdminView);
  const [addUserOpen, setAddUserOpen] = useState(false);
  const [editUserId, setEditUserId] = useState<string | null>(null);
  const [addNodeOpen, setAddNodeOpen] = useState(false);
  const [assignTarget, setAssignTarget] = useState<{ userId?: string } | null>(null);
  const [credentialsNodeId, setCredentialsNodeId] = useState<string | null>(null);
  const [manageExecutorsNodeId, setManageExecutorsNodeId] = useState<string | null>(null);
  const [highlightedUserId, setHighlightedUserId] = useState<string | null>(null);
  const [highlightedNodeId, setHighlightedNodeId] = useState<string | null>(null);
  /** A created user whose computer could not be attached — the user is
      real, so this is a warning to resolve from Assign, not a failed request. */
  const [assignmentWarning, setAssignmentWarning] = useState<string | null>(null);
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

  const unassignedNodes = useMemo(() => nodes.filter((node) => !node.userId), [nodes]);
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
    mergeNodes((prev) => ({
      ...prev,
      nodes: prev.nodes.map((current) => (current.id === updated.id ? updated : current)),
    }));
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
      mergeNodes((prev) => ({
        ...prev,
        nodes: prev.nodes.map((current) => (current.id === result.node.id ? result.node : current)),
      }));
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
      mergeNodes((prev) => ({
        ...prev,
        nodes: prev.nodes.filter((current) => (
          node.managedNodeId
            ? current.managedNodeId !== node.managedNodeId && current.id !== node.id
            : current.id !== node.id
        )),
      }));
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
      mergeNodes((prev) => ({
        users: prev.users.filter((current) => current.id !== user.id),
        nodes: prev.nodes.map((current) =>
          unassignedSet.has(current.id) ? omit(current, "userId") : current,
        ),
      }));
    } catch (error) {
      reportMutationError("Failed to delete user", error, t("errors.admin_delete_user"));
      throw error;
    }
  }

  function handleEditUserSuccess(user: UserRecord) {
    mergeNodes((prev) => ({
      ...prev,
      users: prev.users.map((item) => (item.id === user.id ? user : item)),
    }));
    setEditUserId(null);
  }

  function handleAddUserSuccess(result: CreateControlPanelUserResponse) {
    const { node } = result;
    mergeNodes((prev) => ({
      nodes: node ? [node, ...prev.nodes.filter((current) => current.id !== node.id)] : prev.nodes,
      users: [result.user, ...prev.users.filter((user) => user.id !== result.user.id)],
    }));

    if (node?.nodeToken) {
      writeStoredNodeToken(node.id, {
        userId: result.user.id,
        nodeToken: node.nodeToken,
        savedAt: new Date().toISOString(),
      });
      setStoredTokens(readStoredNodeTokens());
    }

    setHighlightedUserId(result.user.id);
    window.setTimeout(() => setHighlightedUserId((prev) => (prev === result.user.id ? null : prev)), HIGHLIGHT_PULSE_MS);

    setAddUserOpen(false);
    setView("users");
    // The user exists either way; a computer that got claimed in the
    // meantime is reported alongside them rather than swallowing the result.
    setAssignmentWarning(result.assignmentError ?? null);
    // Only surface the credentials drawer when a sandbox was bound — it is
    // keyed by node id and has nothing to show for an unassigned user.
    if (node) setCredentialsNodeId(node.id);
  }

  function handleAssignSuccess(result: AssignControlPanelDaemonNodeResponse) {
    mergeNodes((prev) => ({
      nodes: [result.node, ...prev.nodes.filter((node) => node.id !== result.node.id)],
      users: [result.user, ...prev.users.filter((user) => user.id !== result.user.id)],
    }));
    setHighlightedUserId(result.user.id);
    window.setTimeout(() => setHighlightedUserId((prev) => (prev === result.user.id ? null : prev)), HIGHLIGHT_PULSE_MS);
    setAssignTarget(null);
    setView("users");
  }

  function handleCreateManagedNodeSuccess(result: CreateManagedNodeResponse) {
    const { node } = result;
    // The pulse used to be keyed on the user, but both node paths switch to
    // the Computers view, where nothing reads that — so provisioning ended with
    // the drawer closing and no confirmation anywhere on screen.
    pulseNode(node.id);
    setAddNodeOpen(false);
    setAssignTarget(null);
    setView("computers");
    // Managed provisioning is asynchronous. The supervisor enrolls the daemon,
    // and the existing node poll displays it once registration succeeds.
    void refetch();
  }

  function pulseNode(nodeId: string) {
    setHighlightedNodeId(nodeId);
    window.setTimeout(
      () => setHighlightedNodeId((prev) => (prev === nodeId ? null : prev)),
      HIGHLIGHT_PULSE_MS,
    );
  }

  function handleCreateManualNodeSuccess(result: CreateControlPanelDaemonNodeResponse) {
    const { node } = result;
    mergeNodes((prev) => ({
      ...prev,
      nodes: [node, ...prev.nodes.filter((current) => current.id !== node.id)],
    }));

    writeStoredNodeToken(node.id, {
      userId: node.userId,
      sandboxToken: result.sandboxToken,
      nodeToken: result.nodeToken,
      daemonCommand: result.daemonCommand,
      savedAt: new Date().toISOString(),
    });
    setStoredTokens(readStoredNodeTokens());
    pulseNode(node.id);
    setAddNodeOpen(false);
    setAssignTarget(null);
    setView("computers");
    setCredentialsNodeId(node.id);
  }

  function handleAddNodeSuccess(outcome: AddNodeDrawerSuccess) {
    if (outcome.kind === "managed") {
      handleCreateManagedNodeSuccess(outcome.result);
    } else {
      handleCreateManualNodeSuccess(outcome.result);
    }
  }

  if (!authChecked) {
    return (
      <section className="admin-console adm-bare">
        <div className="adm-loading" role="status">{t("admin.loading")}</div>
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
  const viewTitle = t(`admin.v2.title_${view}`);
  /* Only the two roster sections own a create action. The dashboard reads;
     its Add computer / Add user pair repeated the sections one click away.
     An EMPTY actions container is not the same as none: the narrow layout
     hides a header that holds nothing but a title (section-rail.css), and an
     empty container kept it on screen as a 1px rule. */
  const showWaitlistInvite = view === "waitlist" && waitlistAvailable;
  const hasHeaderActions = Boolean(headerError) || view === "users" || view === "computers" || showWaitlistInvite;
  const headerCount = view === "users"
    ? t("admin.user_count", { count: users.length })
    : view === "computers"
      ? t("admin.node_count", { count: nodes.length })
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
        {/* Kicker + title, like every other list rail in the app (agents,
            teams, projects). The rail used to carry a subtitle sentence as
            well — three lines of identity above a four-row list, and the one
            rail in the app that had one. */}
        <PageHeader
          kicker={t("admin.control_panel.eyebrow")}
          title={t("admin.control_panel.title")}
          titleAs="h2"
          titleVariant="title"
          layout="stacked"
        />
        <AdminViewToggle view={view} onChange={setView} showWaitlist={waitlistAvailable} />
      </div>

      <div className="sec-main">
        <PageHeader
          title={viewTitle}
          titleAs="h2"
          titleVariant="title"
          count={headerCount}
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
              {/* No manual refresh: the view polls on its own (useAdminNodes),
                  so the button was chrome for a job already done. */}
              {/* One primary per fold: the section's own create action wears
                  the cobalt fill and anything beside it steps down to an
                  outline. Two ghost buttons side by side named no primary at
                  all, which is how a page ends up with no focal point. */}
              {view === "users" ? (
                <Button
                  type="button"
                  className="adm-create-action"
                  onClick={() => setAddUserOpen(true)}
                  tooltip={t("admin.v2.add_user_cta")}
                >
                  <ActionAdd size={ICON.md} aria-hidden="true" />
                  {t("admin.v2.add_user_cta")}
                </Button>
              ) : null}
              {showWaitlistInvite ? (
                <InviteNextButton onInvited={(results) => setWaitlistInvites(results)} />
              ) : null}
              {view === "computers" ? (
                <Button
                  type="button"
                  className="adm-create-action"
                  onClick={() => setAddNodeOpen(true)}
                  tooltip={t("admin.v2.add_node_cta")}
                >
                  <ActionAdd size={ICON.md} aria-hidden="true" />
                  {t("admin.v2.add_node_cta")}
                </Button>
              ) : null}
            </>
          ) : undefined}
        />

        <div className="adm-content">
          <div className="adm-content-main">
            <div key={view} className="adm-view-stage">
              {assignmentWarning ? (
                <Alert variant="boxed" render={<div />}>
                  {t("admin.v2.add_user_assignment_warning", { message: assignmentWarning })}
                  <Button
                    type="button"
                    variant="ghost"
                    size="dense"
                    onClick={() => setAssignmentWarning(null)}
                  >
                    {t("admin.v2.dismiss")}
                  </Button>
                </Alert>
              ) : null}
              {view === "dashboard" ? (
                <DashboardView
                  nodes={nodes} users={users} metrics={metrics}
                  onManageNodes={() => setView("computers")}
                />
              ) : view === "users" ? (
                <UsersView
                  users={users}
                  nodes={nodes}
                  layout={layout}
                  onLayoutChange={setLayout}
                  onAddUser={() => setAddUserOpen(true)}
                  onDeleteUser={handleDeleteUser}
                  onEditUser={canEditUsers ? (user) => setEditUserId(user.id) : undefined}
                  highlightedUserId={highlightedUserId}
                />
              ) : view === "organization" ? (
                <SettingsView />
              ) : view === "waitlist" ? (
                waitlistAvailable ? (
                  <WaitlistView
                    invites={waitlistInvites}
                    onInvited={(results) => setWaitlistInvites(results)}
                    onDismissInvites={() => setWaitlistInvites(null)}
                  />
                ) : orgSettingsQuery.isPending ? (
                  <div className="adm-loading" role="status">{t("admin.loading")}</div>
                ) : (
                  <RelayEmptyState className="adm-users-empty" fill title={t("admin.waitlist.unavailable")} />
                )
              ) : (
                <>
                  <NodesView
                    nodes={nodes}
                    users={users}
                    layout={layout}
                    onLayoutChange={setLayout}
                    onRevealCredentials={handleRevealCredentials}
                    onRenameNode={(node) => void handleRenameNode(node)}
                    onManageExecutors={handleManageExecutors}
                    onDeleteNode={handleDeleteNode}
                    onAddNode={() => setAddNodeOpen(true)}
                    highlightedNodeId={highlightedNodeId}
                  />
                  <ManagedNodeHistory
                    nodes={managedNodes}
                    users={users}
                    onRecover={handleRecoverManagedNode}
                    onDeletePermanently={handlePermanentlyDeleteManagedNode}
                  />
                </>
              )}
            </div>
          </div>
        </div>
      </div>

      <AddUserDrawer
        open={addUserOpen}
        onClose={() => setAddUserOpen(false)}
        unassignedNodes={unassignedNodes}
        defaultMaxLocalComputers={canEditUsers ? defaultMaxLocalComputers : undefined}
        allowLimitOverride={canEditUsers}
        onSuccess={handleAddUserSuccess}
      />
      <EditUserDrawer
        open={editUserId !== null}
        onClose={() => setEditUserId(null)}
        user={users.find((user) => user.id === editUserId) ?? null}
        defaultMaxLocalComputers={defaultMaxLocalComputers}
        onSuccess={handleEditUserSuccess}
      />
      <AddNodeDrawer
        open={addNodeOpen}
        onClose={() => setAddNodeOpen(false)}
        users={users}
        onSuccess={handleAddNodeSuccess}
      />
      <AssignNodeDrawer
        open={assignTarget !== null}
        onClose={() => setAssignTarget(null)}
        users={users}
        unassignedNodes={unassignedNodes}
        defaultUserId={assignTarget?.userId}
        onAssignSuccess={handleAssignSuccess}
        onCreateNodeSuccess={handleAddNodeSuccess}
      />
      <CredentialsDrawer
        open={credentialsNodeId !== null}
        onClose={() => setCredentialsNodeId(null)}
        node={credentialsNode}
        storedToken={credentialsNodeId ? storedTokens[credentialsNodeId] : undefined}
        userHandle={handleForUserId(users, credentialsNode?.userId)}
        onUnassign={handleUnassignNode}
        onDelete={handleDeleteNode}
      />
      <ManageExecutorsDrawer
        open={manageExecutorsNodeId !== null}
        onClose={() => setManageExecutorsNodeId(null)}
        node={manageExecutorsNode}
        userHandle={handleForUserId(users, manageExecutorsNode?.userId)}
        onUpdated={handleNodeUpdated}
        onSave={updateControlPanelDaemonNodeDisabledAgents}
      />
    </section>
  );
}
