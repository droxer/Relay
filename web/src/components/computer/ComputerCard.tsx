"use client";

import type { TFunction } from "i18next";
import { useId, type ReactNode } from "react";
import { Trans } from "react-i18next";
import type { AgentName, ControlPanelDaemonNodeRecord } from "../../types";
import { computerId } from "../../lib/createAgent";
import { computerWorkHref } from "../../lib/workspaceScope";
import { navigateToAppPath } from "../../lib/appRoute";
import { RuntimeRefreshButton } from "./RuntimeRefreshButton";
import { RuntimeMark } from "../RuntimeMark";
import { StateMark } from "../StateMark";
import { NodePresence } from "../admin/NodePresence";
import { TonePill } from "../StatusPill";
import { hasClientUpdate } from "./ClientOutdatedBadge";
import { ComputerConnectionNotice, InlineCopyCommand } from "./ComputerConnectionNotice";
import { ComputerReportCleanup } from "./ComputerReportCleanup";
import { computerConnection, connectionNeedsNotice, type ComputerConnection } from "../../lib/computerConnection";
import { HostOsBadge } from "./HostOsBadge";
import { DaemonVersion } from "./DaemonVersion";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  ActionCopy,
  ActionEdit,
  ActionKey,
  ActionRemove,
  AdminManageExecutors,
  ICON,
  NavMore,
  NodeOwnershipIcon,
} from "../icons";
import { computerName, formatRunElapsed, pathSegments } from "../../lib/computerNodes";
import { labelForExecutor } from "../../lib/agentDisplayNames";
import { runtimeNotReadyDetail, runtimeStateLabel } from "./runtimeStateLabel";
import {
  agentStatusTone,
  copyText,
  formatRelativeTime,
  isNodeOnline,
  nodeAgentPresence,
  nodeOwnershipProfile,
  nodeSandboxProfile,
  orderNodeAgentNames,
  showsLifecycleStatus,
  statusTone,
  visibleNodeAgentNames,
  visualStatus,
} from "../admin/helpers";

export type RuntimeChange = { agent: AgentName; phase: "saving" | "failed" };

/**
 * One of the signed-in user's own computers.
 *
 * Not `NodeCard`: that is a fleet-survey tile built to be scanned 40-at-a-time
 * by an admin, so it compresses a machine to a name, a truncated id, and four
 * runtime statuses. Here there are one or two machines and the reader
 * owns them, so the questions are different — "is anything running on it right
 * now", "which runtimes work", "where does my work land" — and the layout is a
 * record, not a tile.
 */
export function ComputerCard({
  node,
  connection = computerConnection(node),
  reportActions,
  onRename,
  onManageExecutors,
  onRuntimeChange,
  runtimeChange,
  onCopyId,
  onShowToken,
  onDisconnect,
  onOpenThread,
  t,
}: {
  node: ControlPanelDaemonNodeRecord;
  /** The computer's connection reading; liveness alone when not supplied. */
  connection?: ComputerConnection;
  reportActions?: ReactNode;
  onRename: (node: ControlPanelDaemonNodeRecord) => void;
  onManageExecutors: (node: ControlPanelDaemonNodeRecord) => void;
  onRuntimeChange?: (agent: AgentName, enabled: boolean) => void;
  runtimeChange?: RuntimeChange;
  onCopyId?: (node: ControlPanelDaemonNodeRecord) => void;
  onShowToken: (node: ControlPanelDaemonNodeRecord) => void;
  onDisconnect: (node: ControlPanelDaemonNodeRecord) => void;
  onOpenThread?: (sessionId: string) => void;
  t: TFunction;
}) {
  const title = computerName(node) ?? t("computer.unnamed");
  const status = visualStatus(node);
  const ownership = nodeOwnershipProfile(node);
  const sandbox = nodeSandboxProfile(node);
  const visibleRuntimes = visibleNodeAgentNames(node);
  const runtimes = onRuntimeChange
    ? orderNodeAgentNames([
        ...visibleRuntimes.filter((agent) => node.agents[agent] !== undefined || node.agentDetails?.[agent]),
        ...(node.disabledAgents ?? []),
      ])
    : visibleRuntimes;
  const activeRuns = node.activeRuns ?? [];
  const online = isNodeOnline(node);
  const waitingForConnection = connection.state === "pending";
  const revokedConnection = connection.state === "revoked";
  // The status pill only earns its place when it says something the presence
  // readout cannot: provisioning, failed, stopped — the same rule as the
  // admin fleet card (`showsLifecycleStatus`).
  const showStatus = showsLifecycleStatus(status)
    && !(waitingForConnection && status === "provisioning")
    && !revokedConnection;
  const showRuntimesSection = online || (!waitingForConnection && runtimes.length > 0);
  const runtimeSection = showRuntimesSection ? (
    <section className="computer-card-section" data-runtime-controls={onRuntimeChange ? "" : undefined}>
      <div className="computer-card-section-head">
        <h3 className="computer-card-section-title">{t("admin.v2.node_runtimes")}</h3>
        {online ? (
          <div className="computer-card-section-actions">
            <RuntimeRefreshButton nodeId={node.id} online={online}
              supported={Boolean(node.capabilities?.includes("runtime-refresh"))} busy={activeRuns.length > 0} />
          </div>
        ) : null}
      </div>
      {runtimes.length === 0 ? (
        <p className="computer-card-idle">{t(onRuntimeChange ? "computer.runtime_empty" : "admin.v2.node_hosted_agents_empty")}</p>
      ) : (
        <ul className="computer-runtime-list" data-compact={!online && !onRuntimeChange ? "true" : undefined}>
          {runtimes.map((agent) => (
            <RuntimeRow
              key={agent}
              node={node}
              agent={agent}
              computerTitle={title}
              onChange={onRuntimeChange ? (enabled) => onRuntimeChange(agent, enabled) : undefined}
              saving={runtimeChange?.phase === "saving"}
              phase={runtimeChange?.agent === agent ? runtimeChange.phase : undefined}
              t={t}
            />
          ))}
        </ul>
      )}
    </section>
  ) : null;

  return (
    // Stale-aware, matching the presence pill: a daemon that stopped
    // heartbeating is dark even though its record still says `online`.
    <article className="computer-card" data-online={online ? "true" : "false"} data-connection={connection.state}>
      <header className="computer-card-hero">
        <span
          className="computer-card-avatar"
          data-ownership={ownership}
          role="img"
          aria-label={t(`admin.v2.node_ownership_${ownership}`)}
          title={t(`admin.v2.node_ownership_${ownership}`)}
        >
          <NodeOwnershipIcon ownership={ownership} size={ICON.md} aria-hidden="true" />
        </span>
        <div className="computer-card-identity">
          {/* The name owns its line and the status readouts ride under it, as
              on the admin fleet card. Sharing one wrapping row, a long name
              pushed the OS onto a line of its own while a short one kept it
              inline, so no two cards had the same header shape. */}
          <h2 className="computer-card-name" translate="no" title={title}>
            <a
              className="computer-card-name-link"
              href={computerWorkHref(computerId(node))}
              onClick={(event) => {
                if (!event.metaKey && !event.ctrlKey && !event.shiftKey && event.button === 0) {
                  event.preventDefault();
                  void navigateToAppPath(computerWorkHref(computerId(node)));
                }
              }}
            >
              {title}
            </a>
          </h2>
          <div className="computer-card-state">
            {waitingForConnection ? (
              <span className="computer-presence-plain" data-state="pending">
                <StateMark shape="dashed" tone="neutral" />
                <span>{t("computer.connect_waiting")}</span>
              </span>
            ) : revokedConnection ? (
              <span className="computer-presence-plain" data-state="revoked">
                <StateMark shape="ring" tone="bad" />
                <span>{t("computer.connection_revoked_title")}</span>
              </span>
            ) : (
              <NodePresence node={node} t={t} withLabel unsettled={connection.state === "unsettled"} />
            )}
            <HostOsBadge node={node} />
            {showStatus ? (
              <TonePill
                className="adm-status-plain"
                tone={statusTone(status)}
                label={t(`status.${status}`, { defaultValue: status })}
                live={statusTone(status) === "info"}
              />
            ) : null}
          </div>
          {/* The separators are drawn by CSS on each item after the first, and each
              item is nowrap: a wrapping flex row breaks between children, so
              a separator ends up orphaned at the end of one line or the start
              of the next. As inline text the break can only fall between
              items. */}
          <p className="computer-card-sub">
            <span>{t(`admin.v2.node_sandbox_${sandbox}`)}</span>
            {" "}<DaemonVersion node={node} t={t} />
            {node.lastSeenAt && <> <span>{t("computer.last_seen", { time: formatRelativeTime(node.lastSeenAt, t) })}</span></>}
          </p>
          {/* The reader owns this machine, so the fix is theirs to make:
              name the update status and the command together on one quiet line
              under the sub-line instead of repeating it in a header pill. */}
          {hasClientUpdate(node) ? (
            <p className="computer-card-outdated">
              <span className="computer-card-outdated-label">
                <StateMark shape="solid" tone="warn" />
                <span>{t(node.clientOutdated ? "computer.client_update_required" : "computer.client_outdated")}</span>
              </span>
              <span className="computer-card-outdated-sep" aria-hidden="true">·</span>
              <span>
                <Trans i18nKey="computer.client_outdated_fix" t={t} components={{ cmd: <InlineCopyCommand /> }} />
              </span>
            </p>
          ) : null}
        </div>
        <div className="computer-card-actions">
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  type="button"
                  variant="icon"
                  size="icon-dense"
                  aria-label={t("computer.more_actions", { name: title })}
                  title={t("computer.more_actions", { name: title })}
                >
                  <NavMore size={ICON.md} aria-hidden="true" />
                </Button>
              }
            />
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => onManageExecutors(node)}>
                <AdminManageExecutors size={ICON.sm} aria-hidden="true" />
                {onRuntimeChange ? t("computer.runtime_details") : t("admin.v2.manage_executors")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => (onCopyId ? onCopyId(node) : void copyText(node.id))}>
                <ActionCopy size={ICON.sm} aria-hidden="true" />
                {t("admin.copy_node_id")}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => onRename(node)}>
                <ActionEdit size={ICON.sm} aria-hidden="true" />
                {t("thread.rename")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onShowToken(node)}>
                <ActionKey size={ICON.sm} aria-hidden="true" />
                {t("computer.token_button")}
              </DropdownMenuItem>
              {/* Removal is the counterpart to self-service enrollment, but
                  managed-computer lifecycle belongs to the admin control plane. */}
              {node.managedNodeId ? null : (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    danger
                    disabled={activeRuns.length > 0}
                    title={activeRuns.length > 0 ? t("errors.disconnect_computer_active") : undefined}
                    onClick={() => onDisconnect(node)}
                  >
                    <ActionRemove size={ICON.sm} aria-hidden="true" />
                    {t("computer.disconnect")}
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>

      {/* Anything short of plainly online gets a concise sentence: what is
          happening, whether it fixes itself, and the command to run when it
          does not. Waiting-for-connection shows its own terminal check hint. */}
      {connectionNeedsNotice(connection) ? (
        <ComputerConnectionNotice node={node} connection={connection} onShowToken={onShowToken} t={t} />
      ) : waitingForConnection ? (
        <div className="computer-card-connection" data-tone="neutral" role="status">
          <p className="computer-card-connection-body">{t("computer.connect_waiting_hint")}</p>
        </div>
      ) : null}
      {reportActions}
      {onRuntimeChange ? runtimeSection : null}

      {/* Active work only appears while there is some: an idle machine says so
          through its presence pill, not through an empty section. */}
      {activeRuns.length === 0 ? null : (
        <section className="computer-card-section">
          <h3 className="computer-card-section-title">
            {t("computer.now_running")}
            <span className="computer-card-count tnum">{activeRuns.length}</span>
          </h3>
          <ul className="computer-run-list">
            {activeRuns.map((run) => (
              <li key={run.runId} className="computer-run-row">
                <Button
                  variant="ghost"
                  type="button"
                  className="computer-run-open"
                  onClick={onOpenThread ? () => onOpenThread(run.sessionId) : undefined}
                  disabled={!onOpenThread}
                  title={t("computer.open_run_thread")}
                >
                  <StateMark shape="live" className="computer-run-mark" />
                  {/* What the run is doing leads; who runs it is the quiet
                      attribution after it. */}
                  <span className="computer-run-goal">{run.taskGoal || t("computer.untitled_run")}</span>
                  <span className="computer-run-agent">{labelForExecutor(run.agent)}</span>
                  <span className="computer-run-elapsed tnum">{formatRunElapsed(run.startedAt)}</span>
                </Button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {onRuntimeChange ? null : runtimeSection}

      {/* The workspace path is looked up, not read: one quiet footer line.
          The id is copied, never read, so it lives in the overflow menu. */}
      <footer className="computer-card-meta">
        {/* Labelled, so a missing path reads as a fact about the workspace
            rather than a stray "Not reported"; only a real path is code. */}
        <span className="computer-fact-label">{t("computer.fact_workspace")}</span>
        {node.workspacePath ? (
          <span className="code computer-fact-path" title={node.workspacePath}>
            {pathSegments(node.workspacePath).map((segment, index) => (
              <span key={`${index}:${segment}`}>{segment}</span>
            ))}
          </span>
        ) : (
          <span className="computer-fact-path computer-fact-path--unset">{t("computer.fact_unset")}</span>
        )}
        {node.queuedCommandCount > 0 ? (
          <span className="tnum">{t("computer.queued_count", { count: node.queuedCommandCount })}</span>
        ) : null}
      </footer>
    </article>
  );
}

function RuntimeRow({
  node,
  agent,
  computerTitle,
  onChange,
  saving,
  phase,
  t,
}: {
  node: ControlPanelDaemonNodeRecord;
  agent: AgentName;
  computerTitle: string;
  onChange?: (enabled: boolean) => void;
  saving: boolean;
  phase?: RuntimeChange["phase"];
  t: TFunction;
}) {
  const statusId = useId();
  const disabled = Boolean(node.disabledAgents?.includes(agent));
  const agentStatus = node.agents[agent] ?? "unknown";
  const version = node.agentDetails?.[agent]?.version;
  const online = isNodeOnline(node);
  const showDisabledAsStatus = disabled && !onChange;
  const tone = agentStatusTone(!online && agentStatus !== "failed" ? "unknown" : agentStatus, { disabled: showDisabledAsStatus });
  const presence = nodeAgentPresence(node, agent);
  const stateLabel = runtimeStateLabel(node, agent, showDisabledAsStatus, t);
  const detail = runtimeNotReadyDetail(node, agent, showDisabledAsStatus, t);

  const tooltip = [labelForExecutor(agent), stateLabel, version, detail].filter(Boolean).join(" · ");
  // Print visible state text for any non-ready runtime on an online computer
  // (plus failed runtimes when offline) so touch and keyboard users can
  // distinguish Not installed, Not responding, Disabled, and Check failed
  // without repeating "Offline" on every row of an offline card.
  const showStateLabel = tone === "bad" || (online && tone !== "good");

  if (onChange) {
    return (
      <li className="computer-runtime-row" title={tooltip}>
        <span className="computer-runtime-name" translate="no">{labelForExecutor(agent)}</span>
        <RuntimeMark id={statusId} agent={agent} presence={presence} tone={tone} variant="labeled" className="computer-runtime-health">
          <span>{stateLabel}</span>
        </RuntimeMark>
        <div className="computer-runtime-control">
          <span aria-hidden="true">{t(disabled ? "admin.v2.agent_disabled" : "admin.v2.agent_enabled")}</span>
          <Switch
            checked={!disabled}
            onCheckedChange={onChange}
            disabled={saving}
            aria-label={t("computer.runtime_on_computer", { runtime: labelForExecutor(agent), computer: computerTitle })}
            aria-describedby={statusId}
          />
        </div>
        {phase === "saving" ? (
          <p className="computer-runtime-feedback" role="status">{t("admin.v2.saving")}</p>
        ) : phase === "failed" ? (
          <p className="computer-runtime-feedback" role="alert">{t("computer.runtime_save_failed")}</p>
        ) : null}
      </li>
    );
  }

  return (
    <li
      className={`computer-runtime-row${disabled ? " is-disabled" : ""}`}
      title={tooltip}
      tabIndex={0}
      aria-label={tooltip}
    >
      <span className="computer-runtime-name" translate="no">{labelForExecutor(agent)}</span>
      <RuntimeMark agent={agent} presence={presence} tone={tone} variant="labeled" role="img" aria-label={stateLabel} title={stateLabel}>
        {showStateLabel ? <span className="runtime-mark-state" aria-hidden="true">{stateLabel}</span> : null}
      </RuntimeMark>
    </li>
  );
}

/**
 * The card with its live connection reading: liveness joined with what the
 * computer's client last reported about its own transport. Kept apart so the
 * card itself stays a pure rendering of what it is given.
 */
export function LiveComputerCard(props: Omit<Parameters<typeof ComputerCard>[0], "connection" | "reportActions">) {
  const { node, t } = props;
  const connection = computerConnection(node, node.transport);
  return <ComputerCard {...props} connection={connection} reportActions={(
    <ComputerReportCleanup key={node.id} nodeId={node.id} name={computerName(node) ?? t("computer.unnamed")}
      pending={connection.pendingReports} quarantined={connection.quarantinedReports}
      available={isNodeOnline(node) && node.dispatchable !== false}
      supported={Boolean(node.capabilities?.includes("report-cleanup"))} />
  )} />;
}
