"use client";

import type { TFunction } from "i18next";
import type { AgentName, ControlPanelDaemonNodeRecord } from "../../types";
import { RuntimeRefreshButton } from "./RuntimeRefreshButton";
import { RuntimeMark } from "../RuntimeMark";
import { StateMark } from "../StateMark";
import { NodePresence } from "../admin/NodePresence";
import { TonePill } from "../StatusPill";
import { ClientOutdatedBadge } from "./ClientOutdatedBadge";
import { HostOsBadge } from "./HostOsBadge";
import { Button } from "@/components/ui/button";
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
import { formatRunElapsed } from "../../lib/computerNodes";
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
  statusTone,
  visibleNodeAgentNames,
  visualStatus,
} from "../admin/helpers";

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
  onRename,
  onManageExecutors,
  onShowToken,
  onDisconnect,
  onOpenThread,
  t,
}: {
  node: ControlPanelDaemonNodeRecord;
  onRename: (node: ControlPanelDaemonNodeRecord) => void;
  onManageExecutors: (node: ControlPanelDaemonNodeRecord) => void;
  onShowToken: (node: ControlPanelDaemonNodeRecord) => void;
  onDisconnect: (node: ControlPanelDaemonNodeRecord) => void;
  onOpenThread?: (sessionId: string) => void;
  t: TFunction;
}) {
  const named = Boolean(node.displayName?.trim()) && node.displayName !== node.id;
  const title = named ? node.displayName! : t("computer.unnamed");
  const status = visualStatus(node);
  const ownership = nodeOwnershipProfile(node);
  const sandbox = nodeSandboxProfile(node);
  const runtimes = visibleNodeAgentNames(node);
  const activeRuns = node.activeRuns ?? [];
  // The status pill only earns its place when it says something the presence
  // readout below the name cannot: provisioning, failed, stopped.
  const showStatus = status !== "ready" && status !== "stale" && status !== "running";

  return (
    // Stale-aware, matching the presence pill: a daemon that stopped
    // heartbeating is dark even though its record still says `online`.
    <article className="computer-card" data-online={isNodeOnline(node) ? "true" : "false"}>
      <header className="computer-card-hero">
        <span className="computer-card-avatar" data-ownership={ownership} translate="no">
          <NodeOwnershipIcon ownership={ownership} size={ICON.md} aria-hidden="true" />
        </span>
        <div className="computer-card-identity">
          <div className="computer-card-nameline">
            <h2 className="computer-card-name" translate="no">{title}</h2>
            <NodePresence node={node} t={t} withLabel />
            <HostOsBadge node={node} />
            {showStatus ? (
              <TonePill
                className="adm-status-plain"
                tone={statusTone(status)}
                label={t(`status.${status}`, { defaultValue: status })}
                live={statusTone(status) === "info"}
              />
            ) : null}
            <ClientOutdatedBadge node={node} t={t} />
          </div>
          {/* The separators are drawn by CSS on each item after the first, and each
              item is nowrap: a wrapping flex row breaks between children, so
              a separator ends up orphaned at the end of one line or the start
              of the next. As inline text the break can only fall between
              items. */}
          <p className="computer-card-sub">
            <span>{t(`admin.v2.node_ownership_${ownership}`)}</span>{" "}
            <span>{t(`admin.v2.node_sandbox_${sandbox}`)}</span>{" "}
            <span>{t("computer.last_seen", { time: formatRelativeTime(node.lastSeenAt, t) })}</span>
          </p>
          {/* The reader owns this machine, so the fix is theirs to make:
              say it in the open, not only in the badge's hover title. */}
          {node.clientOutdated === true ? (
            <p className="computer-card-outdated">{t("computer.client_outdated_hint")}</p>
          ) : null}
        </div>
        {/* One overflow menu instead of a row of outlined buttons: managing
            agents, copying the id, rename, token, and disconnect are
            occasional, so they stay labelled but out of sight until asked
            for. */}
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
                {t("admin.v2.manage_executors")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => void copyText(node.id)}>
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
                  <DropdownMenuItem danger onClick={() => onDisconnect(node)}>
                    <ActionRemove size={ICON.sm} aria-hidden="true" />
                    {t("computer.disconnect")}
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>

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
                  <span className="computer-run-agent">{labelForExecutor(run.agent)}</span>
                  <span className="computer-run-goal">{run.taskGoal || t("computer.untitled_run")}</span>
                  <span className="computer-run-elapsed tnum">{formatRunElapsed(run.startedAt)}</span>
                </Button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="computer-card-section">
        <div className="computer-card-section-head">
          <h3 className="computer-card-section-title">{t("admin.v2.node_runtimes")}</h3>
          <div className="computer-card-section-actions">
            <RuntimeRefreshButton nodeId={node.id} online={isNodeOnline(node)}
              supported={Boolean(node.capabilities?.includes("runtime-refresh"))} busy={activeRuns.length > 0} />
          </div>
        </div>
        {runtimes.length === 0 ? (
          <p className="computer-card-idle">{t("admin.v2.node_hosted_agents_empty")}</p>
        ) : (
          <ul className="computer-runtime-list">
            {runtimes.map((name) => (
              <RuntimeRow key={name} node={node} agent={name} t={t} />
            ))}
          </ul>
        )}
      </section>

      {/* The workspace path is looked up, not read: one quiet footer line.
          The id is copied, never read, so it lives in the overflow menu. */}
      <footer className="computer-card-meta">
        <span className="code computer-fact-path" title={node.workspacePath}>
          {node.workspacePath || t("computer.fact_unset")}
        </span>
        {node.queuedCommandCount > 0 ? (
          <span className="tnum">{t("admin.queued")} {node.queuedCommandCount}</span>
        ) : null}
      </footer>
    </article>
  );
}

function RuntimeRow({
  node,
  agent,
  t,
}: {
  node: ControlPanelDaemonNodeRecord;
  agent: AgentName;
  t: TFunction;
}) {
  const disabled = Boolean(node.disabledAgents?.includes(agent));
  const agentStatus = node.agents[agent] ?? "unknown";
  const version = node.agentDetails?.[agent]?.version;
  const tone = agentStatusTone(!isNodeOnline(node) && agentStatus !== "failed" ? "unknown" : agentStatus, { disabled });
  const presence = nodeAgentPresence(node, agent);
  const stateLabel = runtimeStateLabel(node, agent, disabled, t);
  const detail = runtimeNotReadyDetail(node, agent, disabled);

  const tooltip = [labelForExecutor(agent), stateLabel, version, detail].filter(Boolean).join(" · ");

  return (
    <li className={`computer-runtime-row${disabled ? " is-disabled" : ""}`} title={tooltip}>
      <span className="computer-runtime-name" translate="no">{labelForExecutor(agent)}</span>
      <RuntimeMark agent={agent} presence={presence} tone={tone} variant="labeled" role="img" aria-label={stateLabel} title={stateLabel} />
    </li>
  );
}
