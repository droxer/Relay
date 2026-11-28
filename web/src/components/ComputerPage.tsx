"use client";

import { useMemo, useRef, useState } from "react";
import { useQueryClient, type QueryStatus } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  disconnectComputer,
  RelayApiError,
  updateComputerDisplayName,
  updateDaemonNodeDisabledAgents,
} from "../api";
import type {
  AgentName,
  ControlPanelDaemonNodeRecord,
  CreateLocalDeviceEnrollmentResponse,
  CurrentUser,
  DaemonNodeMonitorRecord,
} from "../types";
import {
  countUserDeviceComputers,
  nodesAssignedToUser,
} from "../lib/computerNodes";
import { useMutationError } from "../hooks/useMutationError";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { NODES_QUERY_KEY } from "../hooks/useRelayData";
import { PHONE_QUERY } from "./MobileTopbarSlot";
import { useDialogs } from "@/components/ui/DialogProvider";
import { LiveComputerCard, type RuntimeChange } from "./computer/ComputerCard";
import { ConnectComputerDrawer } from "./computer/ConnectComputerDrawer";
import { ComputerTokenDrawer } from "./computer/ComputerTokenDrawer";
import { ManageExecutorsDrawer } from "./admin/ManageExecutorsDrawer";
import { Button } from "@/components/ui/button";
import { PageHeader } from "./PageHeader";
import { paginate } from "../lib/pagination";
import { usePagination } from "../hooks/usePagination";
import { Pagination } from "@/components/ui/Pagination";
import { RelayEmptyState } from "./RelayEmptyState";
import { ListSkeleton } from "./ListSkeleton";
import {
  ActionAdd,
  AdminNode,
  ICON,
  ICON_STROKE_LARGE,
  StatusInfo,
} from "./icons";
import { omit } from "../lib/omit";
import { copyText } from "./admin/helpers";
import { isNodeOnline, isPersonalComputer } from "../lib/adminHelpers";
import { labelForExecutor } from "../lib/agentDisplayNames";
import { normalizeDisabledAgentsPayload } from "../lib/manageExecutors";

export function ComputerPage({
  nodes,
  nodesStatus,
  onRetry,
  currentUser,
  onOpenThread,
}: {
  nodes: DaemonNodeMonitorRecord[];
  nodesStatus: QueryStatus;
  onRetry: () => void;
  currentUser: CurrentUser;
  /** Opens the thread behind a run, so "something is running" is one click
      away from "here is what it is doing". */
  onOpenThread?: (sessionId: string) => void;
}) {
  const { t } = useTranslation();
  const { confirm, prompt, announce } = useDialogs();
  const { reportMutationError } = useMutationError();
  const queryClient = useQueryClient();
  const savingRuntimeNodes = useRef(new Set<string>());
  const [runtimeChanges, setRuntimeChanges] = useState<Record<string, RuntimeChange>>({});
  const [overrides, setOverrides] = useState<Record<string, ControlPanelDaemonNodeRecord>>({});
  const [manageExecutorsNodeId, setManageExecutorsNodeId] = useState<string | null>(null);
  const [tokenNodeId, setTokenNodeId] = useState<string | null>(null);
  const [connectDrawerOpen, setConnectDrawerOpen] = useState(false);
  const { page, setPage } = usePagination();
  // Removed ids are held locally so the row disappears on confirm instead of
  // lingering until the next 3s poll catches up with the delete.
  const [removedIds, setRemovedIds] = useState<string[]>([]);

  const myNodes = useMemo<ControlPanelDaemonNodeRecord[]>(() => {
    const merged = nodesAssignedToUser(nodes, currentUser.userId).map(
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
      (node) => !knownIds.has(node.id) && node.userId === currentUser.userId,
    );
    const removed = new Set(removedIds);
    return nodesAssignedToUser(
      [...newlyConnected, ...merged].filter((node) => !removed.has(node.id)),
      currentUser.userId,
    );
  }, [nodes, currentUser.userId, overrides, removedIds]);

  const pagedNodes = useMemo(() => paginate(myNodes, page), [myNodes, page]);
  const onlineCount = useMemo(() => myNodes.filter(isNodeOnline).length, [myNodes]);
  const noComputers = myNodes.length === 0;
  const manageExecutorsNode = myNodes.find((node) => node.id === manageExecutorsNodeId) ?? null;
  const tokenNode = myNodes.find((node) => node.id === tokenNodeId) ?? null;

  // Gate the connect CTA on the caller's resolved local-computer limit. The
  // backend stays the authority (a new enrollment that races the poll still
  // gets a 409), but the button should say so before the round trip. The
  // count comes from the roster on screen — not the /auth/me snapshot — so a
  // connect or disconnect in this session moves it immediately.
  const computerLimit = currentUser.effectiveMaxLocalComputers;
  const computersUsed = countUserDeviceComputers(myNodes);
  const atLimit = computerLimit !== undefined && computersUsed >= computerLimit;
  const limitHint = atLimit
    ? t("computer.limit_reached", { used: computersUsed, limit: computerLimit })
    : null;

  const phone = useMediaQuery(PHONE_QUERY);
  /* In the phone top bar the create control is the same quiet icon square
     every list header portals there (Skills, Agents, Teams): the bar has room
     for glyphs, not a labelled accent button beside the title and the bell.
     The usage readout rides in the tooltip; the limit reason still shows
     with the empty state and in the drawer. */
  const connectIconAction = (
    <Button
      variant="ghost"
      type="button"
      className="page-header-icon-action page-header-icon-action--primary page-header-create-action"
      tooltip={limitHint ?? (computerLimit !== undefined
        ? `${t("computer.connect_button")} · ${computersUsed}/${computerLimit}`
        : t("computer.connect_button"))}
      disabled={atLimit}
      onClick={() => setConnectDrawerOpen(true)}
    >
      <ActionAdd size={ICON.md} aria-hidden="true" />
      <span className="page-header-create-label">{t("computer.connect_button")}</span>
    </Button>
  );
  const connectCta = (
    size: "default" | "sm",
    variant: "default" | "ghost" = "default",
    showReason = false,
  ) => (
    <div className="computer-connect-cta">
      {/* Connecting a computer is what this page is for, so the CTA carries
          the accent — once. With no computers the empty state's CTA is the
          primary and the header's steps down to ghost, so the two never
          compete. The usage readout (2/3) rides on the button; the limit
          reason sits beside the action only in the empty state — in the
          header it would wrap the corner into a ragged paragraph, so there
          it becomes the notice above the roster. */}
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
      {showReason && limitHint ? <p className="computer-connect-limit">{limitHint}</p> : null}
    </div>
  );

  function handleNodeUpdated(updated: ControlPanelDaemonNodeRecord) {
    setOverrides((prev) => ({ ...prev, [updated.id]: updated }));
  }

  async function handleRuntimeChange(node: ControlPanelDaemonNodeRecord, agent: AgentName, enabled: boolean) {
    if (savingRuntimeNodes.current.has(node.id)) return;
    savingRuntimeNodes.current.add(node.id);
    try {
      if (!enabled && node.agents[agent] === "ready") {
        const accepted = await confirm({
          title: t("admin.v2.manage_executors_disable_confirm", { agents: labelForExecutor(agent) }),
          message: t("admin.v2.manage_executors_disable_message"),
          confirmLabel: t("admin.v2.save_agent_settings"),
          tone: "danger",
        });
        if (!accepted) return;
      }

      setRuntimeChanges((current) => ({ ...current, [node.id]: { agent, phase: "saving" } }));
      const cached = queryClient.getQueryData<DaemonNodeMonitorRecord[]>(NODES_QUERY_KEY)?.find((item) => item.id === node.id);
      const latest = cached && cached.updatedAt >= node.updatedAt ? cached : node;
      const disabled = new Set(latest.disabledAgents ?? []);
      if (enabled) disabled.delete(agent);
      else disabled.add(agent);
      const { node: updated } = await updateDaemonNodeDisabledAgents(node.id, normalizeDisabledAgentsPayload(disabled));

      // Keep a poll started before the save from replacing the acknowledged settings.
      await queryClient.cancelQueries({ queryKey: NODES_QUERY_KEY, exact: true });
      queryClient.setQueryData<DaemonNodeMonitorRecord[]>(NODES_QUERY_KEY, (current) =>
        current?.map((item) => item.id === updated.id && item.updatedAt <= updated.updatedAt
          ? { ...item, disabledAgents: updated.disabledAgents, updatedAt: updated.updatedAt }
          : item),
      );
      setRuntimeChanges((current) => omit(current, node.id));
      void queryClient.invalidateQueries({ queryKey: NODES_QUERY_KEY, exact: true });
    } catch {
      setRuntimeChanges((current) => ({ ...current, [node.id]: { agent, phase: "failed" } }));
    } finally {
      savingRuntimeNodes.current.delete(node.id);
    }
  }

  function handleConnected(result: CreateLocalDeviceEnrollmentResponse) {
    // Re-connecting an id that was just removed must bring it back.
    setRemovedIds((prev) => prev.filter((id) => id !== result.node.id));
    handleNodeUpdated(result.node);
  }

  async function handleCopyNodeId(node: ControlPanelDaemonNodeRecord) {
    try {
      await copyText(node.id);
      announce({ message: t("computer.node_id_copied"), tone: "success" });
    } catch {
      announce({ message: t("computer.copy_failed"), tone: "error" });
    }
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
      setOverrides((prev) => omit(prev, node.id));
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
      {/* A dedicated Infra page with no rail beside it, so it owns the page
          h1 — but it wears the same header grammar as the threads, agents,
          teams and issues headers: the 17px title rung and a count on one
          --header-h row, with the connect action centred on that row. The
          Infra eyebrow, the 22px display title and the description line made
          this the one ~126px header in the app; the empty state still says
          what the page is for. */}
      <PageHeader
        title={t("computer.title")}
        count={!noComputers
          ? `${t("computer.count", { count: myNodes.length })} · ${t("computer.online_count", { count: onlineCount })}`
          : nodesStatus === "success" ? t("computer.count", { count: 0 }) : undefined}
        titleVariant="title"
        actions={phone ? connectIconAction : connectCta("sm", myNodes.length === 0 ? "ghost" : "default")}
        /* On a phone the title lives in the top bar, so the create control
           goes there too (as Skills does) instead of keeping a band of its
           own under the section tabs. */
        topbarActions
      />
      {/* The shell clips its children, so the roster needs its own scroll
          container — see computer.css. */}
      <div className="computer-page-body">
        {noComputers && nodesStatus === "pending" ? (
          <ListSkeleton label={t("admin.loading")} rows={3} />
        ) : noComputers && nodesStatus === "error" ? (
          <RelayEmptyState feature="computers"
            title={t("computer.load_failed")}
            actions={<Button type="button" variant="outline" onClick={onRetry}>{t("workspace.retry")}</Button>}
          />
        ) : noComputers ? (
          <RelayEmptyState feature="computers"
            title={t("computer.empty_title")}
            body={t("computer.empty_body")}
            illustration={<AdminNode size={ICON.hero} strokeWidth={ICON_STROKE_LARGE} aria-hidden="true" />}
            actions={connectCta("default", "default", true)}
          />
        ) : (
          <>
          {limitHint ? (
            <p className="computer-limit-notice" role="status">
              <StatusInfo size={ICON.sm} aria-hidden="true" />
              <span>{limitHint}</span>
            </p>
          ) : null}
          <ul className="computer-list">
            {pagedNodes.items.map((node) => (
              <li key={node.id}>
                <LiveComputerCard
                  node={node}
                  runtimeChange={runtimeChanges[node.id]}
                  onRuntimeChange={isPersonalComputer(node)
                    ? (agent, enabled) => void handleRuntimeChange(node, agent, enabled)
                    : undefined}
                  onRename={(target) => void handleRenameNode(target)}
                  onManageExecutors={(target) => setManageExecutorsNodeId(target.id)}
                  onCopyId={(target) => void handleCopyNodeId(target)}
                  onShowToken={(target) => setTokenNodeId(target.id)}
                  onDisconnect={(target) => void handleDisconnectNode(target)}
                  onOpenThread={onOpenThread}
                  t={t}
                />
              </li>
            ))}
          </ul>
          </>
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
        readOnly={manageExecutorsNode !== null && isPersonalComputer(manageExecutorsNode)}
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
