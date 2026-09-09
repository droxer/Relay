"use client";

import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { DashboardView } from "./admin/dashboard/DashboardView";
import { useNodeMetrics } from "../hooks/useNodeMetrics";
import { useTranslation } from "react-i18next";
import { handleForEmployeeId } from "../lib/employeeHandle";
import { StateMark } from "./StateMark";
import { useMutationError } from "../hooks/useMutationError";
import { Button } from "@/components/ui/button";
import {
  ActionAdd,
  ICON,
} from "./icons";
import { getOrgSettings, deleteControlPanelDaemonNode, deleteControlPanelEmployee, deleteManagedNode, getAuthStatus, getMe, listManagedNodes, permanentlyDeleteManagedNode, recoverManagedNode, RelayApiError, unassignControlPanelDaemonNode, updateComputerDisplayName, updateControlPanelDaemonNodeDisabledAgents, updateManagedNodeDisplayName } from "../api";
import type {
  AssignControlPanelDaemonNodeResponse,
  ControlPanelDaemonNodeRecord,
  CreateManagedNodeResponse,
  CreateControlPanelDaemonNodeResponse,
  CreateControlPanelEmployeeResponse,
  CurrentUser,
  DaemonNodeMonitorRecord,
  EmployeeRecord,
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
import { AddEmployeeDrawer } from "./admin/AddEmployeeDrawer";
import { AddNodeDrawer, type AddNodeDrawerSuccess } from "./admin/AddNodeDrawer";
import { EmployeesView } from "./admin/EmployeesView";
import { EditEmployeeDrawer } from "./admin/EditEmployeeDrawer";
import { SettingsView } from "./admin/SettingsView";
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

type AuthScreen = "login" | "bootstrap";
export function AdminPage({ currentUser }: { currentUser?: CurrentUser | null }) {
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

  const [view, setView] = useState<AdminView>("dashboard");
  const [layout, setLayout] = useState<AdminLayout>("card");
  const { nodes, employees, pollError, mergeNodes, refetch } = useAdminNodes(
    Boolean(admin),
    view === "dashboard" || layout === "list",
  );
  const managedNodesQuery = useQuery({
    queryKey: ["admin", "managed-nodes"],
    queryFn: ({ signal }) => listManagedNodes(signal),
    enabled: Boolean(admin) && view === "nodes",
    refetchInterval: CONTROL_PANEL_POLL_MS,
  });
  const managedNodes = managedNodesQuery.data?.nodes ?? [];
  // The org default is what an employee without an override follows, so the
  // employee forms show it as their placeholder.
  const orgSettingsQuery = useQuery({
    queryKey: ["admin", "settings"],
    queryFn: ({ signal }) => getOrgSettings(signal),
    enabled: Boolean(admin),
  });
  const defaultMaxLocalComputers = orgSettingsQuery.data?.settings.maxLocalComputersPerEmployee;
  // Absent while the query is in flight; only a definite false hides the
  // controls, so a slow answer does not flash them away.
  const canEditEmployees = orgSettingsQuery.data?.capabilities?.employeeEdits !== false;
  const setAdminView = useRelayStore((state) => state.setAdminView);
  const [addEmployeeOpen, setAddEmployeeOpen] = useState(false);
  const [editEmployeeId, setEditEmployeeId] = useState<string | null>(null);
  const [addNodeOpen, setAddNodeOpen] = useState(false);
  const [assignTarget, setAssignTarget] = useState<{ employeeId?: string } | null>(null);
  const [credentialsNodeId, setCredentialsNodeId] = useState<string | null>(null);
  const [manageExecutorsNodeId, setManageExecutorsNodeId] = useState<string | null>(null);
  const [highlightedEmployeeId, setHighlightedEmployeeId] = useState<string | null>(null);
  const [highlightedNodeId, setHighlightedNodeId] = useState<string | null>(null);
  /** A created employee whose computer could not be attached — the employee is
      real, so this is a warning to resolve from Assign, not a failed request. */
  const [assignmentWarning, setAssignmentWarning] = useState<string | null>(null);
  const [storedTokens, setStoredTokens] = useState<StoredNodeTokenMap>(() => readStoredNodeTokens());

  async function checkAuth(signal?: AbortSignal) {
    try {
      const statusResult = await getAuthStatus(signal);
      setNeedsBootstrap(statusResult.requiresBootstrap);
      setAuthScreen(statusResult.requiresBootstrap ? "bootstrap" : "login");
    } catch {
      setNeedsBootstrap(false);
    }
    try {
      const result = await getMe(signal);
      if (result.authenticated && result.user?.role === "admin") {
        setAdmin(result.user);
      } else {
        setAdmin(null);
      }
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") return;
      const status = err && typeof err === "object" && "status" in err ? (err as { status: number }).status : 0;
      setAdmin(null);
      if (status === 503) setAuthError(t("admin.admin_token_required"));
    } finally {
      setAuthChecked(true);
    }
  }

  useEffect(() => {
    // Already authenticated via the app session — no probe needed on mount.
    if (seededAdmin) return;
    const controller = new AbortController();
    void checkAuth(controller.signal);
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The node poll lives in useAdminNodes; a failure that looks like an expired
  // session drops us back to the login screen (the query disables once admin
  // clears).
  useEffect(() => {
    if (pollError && (pollError.includes("401") || pollError.includes("Session expired") || pollError.includes("Admin token is required"))) {
      setAdmin(null);
    }
  }, [pollError]);

  useEffect(() => {
    setAdminView(view);
  }, [setAdminView, view]);

  const metrics = useNodeMetrics(nodes, employees);

  const unassignedNodes = useMemo(() => nodes.filter((node) => !node.employeeId), [nodes]);
  const credentialsNode = useMemo(
    () => (credentialsNodeId ? nodes.find((node) => node.id === credentialsNodeId) ?? null : null),
    [credentialsNodeId, nodes],
  );
  const manageExecutorsNode = useMemo(
    () => (manageExecutorsNodeId ? nodes.find((node) => node.id === manageExecutorsNodeId) ?? null : null),
    [manageExecutorsNodeId, nodes],
  );

  useEffect(() => {
    setStoredTokens((current) => {
      const updated = upsertStoredCredentialsFromNodes(current, nodes);
      if (!updated) return current;
      persistStoredNodeTokenMap(updated);
      return updated;
    });
  }, [nodes]);

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

  async function handleDeleteEmployee(employee: EmployeeRecord) {
    try {
      const result = await deleteControlPanelEmployee(employee.id);
      const unassignedSet = new Set(result.unassignedNodes);
      mergeNodes((prev) => ({
        employees: prev.employees.filter((current) => current.id !== employee.id),
        nodes: prev.nodes.map((current) =>
          unassignedSet.has(current.id) ? (({ employeeId: _ignored, ...rest }) => rest)(current) : current,
        ),
      }));
    } catch (error) {
      reportMutationError("Failed to delete employee", error, t("errors.admin_delete_employee"));
      throw error;
    }
  }

  function handleEditEmployeeSuccess(employee: EmployeeRecord) {
    mergeNodes((prev) => ({
      ...prev,
      employees: prev.employees.map((item) => (item.id === employee.id ? employee : item)),
    }));
    setEditEmployeeId(null);
  }

  function handleAddEmployeeSuccess(result: CreateControlPanelEmployeeResponse) {
    const { node } = result;
    mergeNodes((prev) => ({
      nodes: node ? [node, ...prev.nodes.filter((current) => current.id !== node.id)] : prev.nodes,
      employees: [result.employee, ...prev.employees.filter((employee) => employee.id !== result.employee.id)],
    }));

    if (node?.nodeToken) {
      writeStoredNodeToken(node.id, {
        employeeId: result.employee.id,
        nodeToken: node.nodeToken,
        savedAt: new Date().toISOString(),
      });
      setStoredTokens(readStoredNodeTokens());
    }

    setHighlightedEmployeeId(result.employee.id);
    window.setTimeout(() => setHighlightedEmployeeId((prev) => (prev === result.employee.id ? null : prev)), HIGHLIGHT_PULSE_MS);

    setAddEmployeeOpen(false);
    setView("employees");
    // The employee exists either way; a computer that got claimed in the
    // meantime is reported alongside them rather than swallowing the result.
    setAssignmentWarning(result.assignmentError ?? null);
    // Only surface the credentials drawer when a sandbox was bound — it is
    // keyed by node id and has nothing to show for an unassigned employee.
    if (node) setCredentialsNodeId(node.id);
  }

  function handleAssignSuccess(result: AssignControlPanelDaemonNodeResponse) {
    mergeNodes((prev) => ({
      nodes: [result.node, ...prev.nodes.filter((node) => node.id !== result.node.id)],
      employees: [result.employee, ...prev.employees.filter((employee) => employee.id !== result.employee.id)],
    }));
    setHighlightedEmployeeId(result.employee.id);
    window.setTimeout(() => setHighlightedEmployeeId((prev) => (prev === result.employee.id ? null : prev)), HIGHLIGHT_PULSE_MS);
    setAssignTarget(null);
    setView("employees");
  }

  function handleCreateManagedNodeSuccess(result: CreateManagedNodeResponse) {
    const { node } = result;
    // The pulse used to be keyed on the employee, but both node paths switch to
    // the Computers view, where nothing reads that — so provisioning ended with
    // the drawer closing and no confirmation anywhere on screen.
    pulseNode(node.id);
    setAddNodeOpen(false);
    setAssignTarget(null);
    setView("nodes");
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
      employeeId: node.employeeId,
      sandboxToken: result.sandboxToken,
      nodeToken: result.nodeToken,
      daemonCommand: result.daemonCommand,
      savedAt: new Date().toISOString(),
    });
    setStoredTokens(readStoredNodeTokens());
    pulseNode(node.id);
    setAddNodeOpen(false);
    setAssignTarget(null);
    setView("nodes");
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

  const managedNodesError = view === "nodes" && managedNodesQuery.error instanceof Error
    ? managedNodesQuery.error.message
    : view === "nodes" && managedNodesQuery.error
      ? String(managedNodesQuery.error)
      : null;
  const headerError = authError ?? pollError ?? managedNodesError;
  const viewTitle = t(`admin.v2.title_${view}`);
  const headerCount = view === "employees"
    ? t("admin.employee_count", { count: employees.length })
    : view === "nodes"
      ? t("admin.node_count", { count: nodes.length })
      : undefined;

  return (
    <section
      id="admin-panel"
      className="admin-console adm-shell"
      data-admin-view={view}
      aria-label={viewTitle}
      tabIndex={-1}
    >
      <PageHeader
        kicker={t("admin.control_panel.eyebrow")}
        title={t("admin.control_panel.title")}
        subtitle={t("admin.control_panel.subtitle")}
        count={headerCount}
        actions={
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
            {view === "dashboard" ? (
              <>
                <Button
                  type="button"
                  variant="ghost"
                  className="adm-create-action"
                  onClick={() => setAddNodeOpen(true)}
                  tooltip={t("admin.v2.add_node_cta")}
                >
                  <ActionAdd size={ICON.md} aria-hidden="true" />
                  {t("admin.v2.add_node_cta")}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  className="adm-create-action"
                  onClick={() => setAddEmployeeOpen(true)}
                  tooltip={t("admin.v2.add_employee_cta")}
                >
                  <ActionAdd size={ICON.md} aria-hidden="true" />
                  {t("admin.v2.add_employee_cta")}
                </Button>
              </>
            ) : null}
            {view === "employees" ? (
              <Button
                type="button"
                variant="ghost"
                className="adm-create-action"
                onClick={() => setAddEmployeeOpen(true)}
                tooltip={t("admin.v2.add_employee_cta")}
              >
                <ActionAdd size={ICON.md} aria-hidden="true" />
                {t("admin.v2.add_employee_cta")}
              </Button>
            ) : null}
            {view === "nodes" ? (
              <Button
                type="button"
                variant="ghost"
                className="adm-create-action"
                onClick={() => setAddNodeOpen(true)}
                tooltip={t("admin.v2.add_node_cta")}
              >
                <ActionAdd size={ICON.md} aria-hidden="true" />
                {t("admin.v2.add_node_cta")}
              </Button>
            ) : null}
          </>
        }
      />

      <div className="adm-section-nav">
        <AdminViewToggle view={view} onChange={setView} />
        <span className="adm-section-context">{t("admin.control_panel.workspace")}</span>
      </div>

      <div className="adm-main">
        <div className="adm-content">
          <div className="adm-content-main">
            <div key={view} className="adm-view-stage">
              {assignmentWarning ? (
                <Alert variant="boxed" render={<div />}>
                  {t("admin.v2.add_employee_assignment_warning", { message: assignmentWarning })}
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
                  nodes={nodes} employees={employees} metrics={metrics}
                  onManageNodes={() => setView("nodes")}
                />
              ) : view === "employees" ? (
                <EmployeesView
                  employees={employees}
                  nodes={nodes}
                  layout={layout}
                  onLayoutChange={setLayout}
                  onAddEmployee={() => setAddEmployeeOpen(true)}
                  onDeleteEmployee={handleDeleteEmployee}
                  onEditEmployee={canEditEmployees ? (employee) => setEditEmployeeId(employee.id) : undefined}
                  highlightedEmployeeId={highlightedEmployeeId}
                />
              ) : view === "settings" ? (
                <SettingsView />
              ) : (
                <>
                  <NodesView
                    nodes={nodes}
                    employees={employees}
                    storedTokens={storedTokens}
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
                    employees={employees}
                    onRecover={handleRecoverManagedNode}
                    onDeletePermanently={handlePermanentlyDeleteManagedNode}
                  />
                </>
              )}
            </div>
          </div>
        </div>
      </div>

      <AddEmployeeDrawer
        open={addEmployeeOpen}
        onClose={() => setAddEmployeeOpen(false)}
        unassignedNodes={unassignedNodes}
        defaultMaxLocalComputers={canEditEmployees ? defaultMaxLocalComputers : undefined}
        allowLimitOverride={canEditEmployees}
        onSuccess={handleAddEmployeeSuccess}
      />
      <EditEmployeeDrawer
        open={editEmployeeId !== null}
        onClose={() => setEditEmployeeId(null)}
        employee={employees.find((employee) => employee.id === editEmployeeId) ?? null}
        defaultMaxLocalComputers={defaultMaxLocalComputers}
        onSuccess={handleEditEmployeeSuccess}
      />
      <AddNodeDrawer
        open={addNodeOpen}
        onClose={() => setAddNodeOpen(false)}
        employees={employees}
        onSuccess={handleAddNodeSuccess}
      />
      <AssignNodeDrawer
        open={assignTarget !== null}
        onClose={() => setAssignTarget(null)}
        employees={employees}
        unassignedNodes={unassignedNodes}
        defaultEmployeeId={assignTarget?.employeeId}
        onAssignSuccess={handleAssignSuccess}
        onCreateNodeSuccess={handleAddNodeSuccess}
      />
      <CredentialsDrawer
        open={credentialsNodeId !== null}
        onClose={() => setCredentialsNodeId(null)}
        node={credentialsNode}
        storedToken={credentialsNodeId ? storedTokens[credentialsNodeId] : undefined}
        employeeHandle={handleForEmployeeId(employees, credentialsNode?.employeeId)}
        onUnassign={handleUnassignNode}
        onDelete={handleDeleteNode}
      />
      <ManageExecutorsDrawer
        open={manageExecutorsNodeId !== null}
        onClose={() => setManageExecutorsNodeId(null)}
        node={manageExecutorsNode}
        employeeHandle={handleForEmployeeId(employees, manageExecutorsNode?.employeeId)}
        onUpdated={handleNodeUpdated}
        onSave={updateControlPanelDaemonNodeDisabledAgents}
      />
    </section>
  );
}
