"use client";

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  disconnectComputer,
  RelayApiError,
  updateComputerDisplayName,
  updateDaemonNodeDisabledAgents,
} from "../api";
import type {
  ControlPanelDaemonNodeRecord,
  CreateLocalDeviceEnrollmentResponse,
  CurrentUser,
  DaemonNodeMonitorRecord,
} from "../types";
import {
  countEmployeeDeviceComputers,
  nodesAssignedToEmployee,
} from "../lib/computerNodes";
import { useMutationError } from "../hooks/useMutationError";
import { useDialogs } from "@/components/ui/DialogProvider";
import { ComputerCard } from "./computer/ComputerCard";
import { ConnectComputerDrawer } from "./computer/ConnectComputerDrawer";
import { ComputerTokenDrawer } from "./computer/ComputerTokenDrawer";
import { ManageExecutorsDrawer } from "./admin/ManageExecutorsDrawer";
import { Button } from "@/components/ui/button";
import { PageHeader } from "./PageHeader";
import { paginate } from "../lib/pagination";
import { usePagination } from "../hooks/usePagination";
import { Pagination } from "@/components/ui/Pagination";
import { RelayEmptyState } from "./RelayEmptyState";
import {
  ActionAdd,
  AdminNode,
  ICON,
  ICON_STROKE_LARGE,
} from "./icons";

export function ComputerPage({
  nodes,
  currentUser,
  onOpenThread,
}: {
  nodes: DaemonNodeMonitorRecord[];
  currentUser: CurrentUser;
  /** Opens the thread behind a run, so "something is running" is one click
      away from "here is what it is doing". */
  onOpenThread?: (sessionId: string) => void;
}) {
  const { t } = useTranslation();
  const { confirm, prompt } = useDialogs();
  const { reportMutationError } = useMutationError();
  const [overrides, setOverrides] = useState<Record<string, ControlPanelDaemonNodeRecord>>({});
  const [manageExecutorsNodeId, setManageExecutorsNodeId] = useState<string | null>(null);
  const [tokenNodeId, setTokenNodeId] = useState<string | null>(null);
  const [connectDrawerOpen, setConnectDrawerOpen] = useState(false);
  const { page, setPage } = usePagination();
  // Removed ids are held locally so the row disappears on confirm instead of
  // lingering until the next 3s poll catches up with the delete.
  const [removedIds, setRemovedIds] = useState<string[]>([]);

  const myNodes = useMemo<ControlPanelDaemonNodeRecord[]>(() => {
    const merged = nodesAssignedToEmployee(nodes, currentUser.employeeId).map(
      (node): ControlPanelDaemonNodeRecord => {
        const override = overrides[node.id];
        if (!override || override.updatedAt < node.updatedAt) return node;
        // Overlay only what this page can edit, rather than letting the whole
        // override win: `online`, `stale`, `activeRuns`, and
        // `queuedCommandCount` are derived per read and never bump
        // `updatedAt`, so a wholesale override would pin a computer to the
        // liveness it had when we wrote it — rename a machine, power it off,
        // and it reads as online until a reload.
        return {
          ...node,
          displayName: override.displayName,
          disabledAgents: override.disabledAgents,
        };
      },
    );
    // A freshly-connected computer lives only in `overrides` until the next
    // nodes poll folds it into `nodes` — surface it immediately instead of
    // waiting on a refetch.
    const knownIds = new Set(merged.map((node) => node.id));
    const newlyConnected = Object.values(overrides).filter(
      (node) => !knownIds.has(node.id) && node.employeeId === currentUser.employeeId,
    );
    const removed = new Set(removedIds);
    return nodesAssignedToEmployee(
      [...newlyConnected, ...merged].filter((node) => !removed.has(node.id)),
      currentUser.employeeId,
    );
  }, [nodes, currentUser.employeeId, overrides, removedIds]);

  const pagedNodes = useMemo(() => paginate(myNodes, page), [myNodes, page]);
  const manageExecutorsNode = myNodes.find((node) => node.id === manageExecutorsNodeId) ?? null;
  const tokenNode = myNodes.find((node) => node.id === tokenNodeId) ?? null;

  // Gate the connect CTA on the caller's resolved local-computer limit. The
  // backend stays the authority (a new enrollment that races the poll still
  // gets a 409), but the button should say so before the round trip. The
  // count comes from the roster on screen — not the /auth/me snapshot — so a
  // connect or disconnect in this session moves it immediately.
  const computerLimit = currentUser.effectiveMaxLocalComputers;
  const computersUsed = countEmployeeDeviceComputers(myNodes);
  const atLimit = computerLimit !== undefined && computersUsed >= computerLimit;
  const limitHint = atLimit
    ? t("computer.limit_reached", { used: computersUsed, limit: computerLimit })
    : null;

  const connectCta = (size: "default" | "sm", variant: "default" | "outline" = "default") => (
    <div className="computer-connect-cta">
      {/* The header CTA takes the quiet outline tier — the cobalt fill is
          reserved for the empty state, where connecting is the page's one
          move. The usage readout (2/3) and limit reason stay attached to the
          action either way. */}
      <Button
        type="button"
        size={size}
        variant={variant}
        onClick={() => setConnectDrawerOpen(true)}
        disabled={atLimit}
        title={limitHint ?? undefined}
      >
        <ActionAdd size={ICON.sm} aria-hidden="true" />
        {t("computer.connect_button")}
        {computerLimit !== undefined ? (
          <span className="computer-connect-usage tnum">
            {computersUsed}/{computerLimit}
          </span>
        ) : null}
      </Button>
      {limitHint ? <p className="computer-connect-limit">{limitHint}</p> : null}
    </div>
  );

  function handleNodeUpdated(updated: ControlPanelDaemonNodeRecord) {
    setOverrides((prev) => ({ ...prev, [updated.id]: updated }));
  }

  function handleConnected(result: CreateLocalDeviceEnrollmentResponse) {
    // Re-connecting an id that was just removed must bring it back.
    setRemovedIds((prev) => prev.filter((id) => id !== result.node.id));
    handleNodeUpdated(result.node);
  }

  async function handleDisconnectNode(node: ControlPanelDaemonNodeRecord) {
    const named = node.displayName?.trim() && node.displayName !== node.id
      ? node.displayName.trim()
      : t("computer.unnamed");
    const confirmed = await confirm({
      title: t("computer.disconnect_title"),
      message: t("computer.disconnect_message", { name: named }),
      confirmLabel: t("computer.disconnect"),
      tone: "danger",
    });
    if (!confirmed) return;
    try {
      await disconnectComputer(node.id);
      setRemovedIds((prev) => (prev.includes(node.id) ? prev : [...prev, node.id]));
      setOverrides((prev) => {
        const { [node.id]: _removed, ...rest } = prev;
        return rest;
      });
    } catch (error) {
      const message = error instanceof RelayApiError && error.status === 409
        ? t("errors.disconnect_computer_active")
        : t("errors.disconnect_computer");
      reportMutationError("Failed to disconnect computer", error, message);
    }
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
      const updated = await updateComputerDisplayName(node.id, displayName || null);
      handleNodeUpdated({ ...node, ...updated.node });
    } catch (error) {
      reportMutationError("Failed to rename computer", error, t("errors.rename_computer"));
    }
  }

  return (
    <section id="computer-panel" className="computer-page" aria-label={t("computer.title")} tabIndex={-1}>
      <PageHeader
        title={t("computer.title")}
        count={t("computer.count", { count: myNodes.length })}
        titleVariant="display"
        layout="stacked"
        actions={connectCta("sm", "outline")}
      />
      {/* The shell clips its children, so the roster needs its own scroll
          container — see computer.css. */}
      <div className="computer-page-body">
        {myNodes.length === 0 ? (
          <RelayEmptyState
            title={t("computer.empty_title")}
            body={t("computer.empty_body")}
            illustration={<AdminNode size={ICON.hero} strokeWidth={ICON_STROKE_LARGE} aria-hidden="true" />}
            actions={connectCta("default")}
          />
        ) : (
          <ul className="computer-list">
            {pagedNodes.items.map((node) => (
              <li key={node.id}>
                <ComputerCard
                  node={node}
                  onRename={(target) => void handleRenameNode(target)}
                  onManageExecutors={(target) => setManageExecutorsNodeId(target.id)}
                  onShowToken={(target) => setTokenNodeId(target.id)}
                  onDisconnect={(target) => void handleDisconnectNode(target)}
                  onOpenThread={onOpenThread}
                  t={t}
                />
              </li>
            ))}
          </ul>
        )}
        {/* Each card is a full record rather than a tile, so a handful of
            machines already fills the viewport — the pager stays absent below
            the threshold and only appears for a fleet that needs it. */}
        <Pagination page={pagedNodes} onPageChange={setPage} label={t("computer.title")} />
      </div>
      <ManageExecutorsDrawer
        open={manageExecutorsNodeId !== null}
        onClose={() => setManageExecutorsNodeId(null)}
        node={manageExecutorsNode}
        onUpdated={handleNodeUpdated}
        onSave={updateDaemonNodeDisabledAgents}
      />
      <ConnectComputerDrawer
        nodes={myNodes}
        open={connectDrawerOpen}
        onClose={() => setConnectDrawerOpen(false)}
        onConnected={handleConnected}
      />
      <ComputerTokenDrawer
        open={tokenNodeId !== null}
        onClose={() => setTokenNodeId(null)}
        node={tokenNode}
      />
    </section>
  );
}
