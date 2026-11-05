"use client";

import type { TFunction } from "i18next";
import type { ControlPanelDaemonNodeRecord, UserRecord } from "../../types";
import { useNodeDelete } from "../../hooks/useNodeDelete";
import { failedRuntimeCount, showsLifecycleStatus, statusTone, visualStatus } from "./helpers";
import { NodeActions } from "./NodeActions";
import { NodeMeta } from "./NodeMeta";
import { NodePresence } from "./NodePresence";
import { NodeRuntimeMarks } from "./NodeRuntimeMarks";
import { TonePill } from "../StatusPill";
import { ClientOutdatedBadge } from "../computer/ClientOutdatedBadge";
import { HostOsBadge } from "../computer/HostOsBadge";
import { isNodeOnline } from "../../lib/adminHelpers";
import { computerName } from "../../lib/computerNodes";

interface NodeCardProps {
  node: ControlPanelDaemonNodeRecord;
  user?: UserRecord;
  onReveal?: (node: ControlPanelDaemonNodeRecord) => void;
  onRename: (node: ControlPanelDaemonNodeRecord) => void;
  onManageExecutors: (node: ControlPanelDaemonNodeRecord) => void;
  onDelete?: (node: ControlPanelDaemonNodeRecord) => Promise<void>;
  /** One-shot marker for a computer that was just created here. */
  highlight?: boolean;
  t: TFunction;
}

export function NodeCard({
  node,
  user,
  onReveal,
  onRename,
  onManageExecutors,
  onDelete,
  highlight = false,
  t,
}: NodeCardProps) {
  const { deletePending, deleteError, handleDelete } = useNodeDelete(node, onDelete, t);

  // An unnamed computer says so in words, as on the owner's page; the id is
  // always the handle under the name, never the title itself.
  const nodeName = computerName(node) ?? t("computer.unnamed");
  const status = visualStatus(node);
  const online = isNodeOnline(node);
  // ONE status readout per card. Presence (Online/Offline) is the ordinary
  // case; the lifecycle pill replaces it only when it says something presence
  // cannot — provisioning, failed, stopped. Busy work is the run count beside
  // it, the rule the owner's card uses too (`showsLifecycleStatus`).
  const showStatusPill = showsLifecycleStatus(status);
  const runCount = node.activeRuns?.length ?? 0;
  const failedRuntimes = failedRuntimeCount(node);

  return (
    <article
      className={`adm-node-card${highlight ? " is-pulse" : ""}`}
      data-online={online ? "true" : "false"}
    >
      <header className="adm-node-card-head">
        <div className="adm-node-card-identity">
          <span className="adm-node-card-name" translate="no" title={nodeName}>
            {nodeName}
          </span>
          <span className="adm-node-card-handle code" translate="no">{node.id}</span>
          {/* The status rides under the name rather than beside it: beside
              it, a card narrower than name + status wrapped the status onto
              a line of its own, floated right next to the menu. */}
          <span className="adm-node-card-state">
            {showStatusPill ? (
              <TonePill
                className="adm-status-plain"
                tone={statusTone(status)}
                label={t(`status.${status}`, { defaultValue: status })}
                live={statusTone(status) === "info"}
              />
            ) : (
              <NodePresence node={node} t={t} withLabel />
            )}
            <HostOsBadge node={node} />
            {/* Work counts ride on the status line rather than in the
                footer, where a queue count wrapped onto a line of its own
                and lifted that card's runtimes out of line with its row. */}
            {runCount > 0 ? (
              <span className="adm-node-card-count tnum">{t("computer.running_count", { count: runCount })}</span>
            ) : null}
            {node.queuedCommandCount > 0 ? (
              <span className="adm-node-card-count tnum">{t("computer.queued_count", { count: node.queuedCommandCount })}</span>
            ) : null}
            {failedRuntimes > 0 ? (
              <span className="adm-node-card-count is-failed tnum">{t("computer.runtimes_failed_count", { count: failedRuntimes })}</span>
            ) : null}
            <ClientOutdatedBadge node={node} t={t} />
          </span>
        </div>
        <div className="adm-node-card-status">
          <NodeActions
            node={node}
            onReveal={onReveal}
            onRename={onRename}
            onManageExecutors={onManageExecutors}
            onDelete={onDelete}
            deletePending={deletePending}
            onDeleteRequest={() => void handleDelete()}
            t={t}
          />
        </div>
      </header>

      <NodeMeta node={node} user={user} t={t} />

      <footer className="adm-node-card-runtimes">
        <span className="adm-node-runtimes" title={t("admin.v2.node_runtimes")}>
          <NodeRuntimeMarks node={node} t={t} />
        </span>
      </footer>
      {deleteError ? (
        <p className="adm-node-card-error" role="alert">{t("admin.v2.action_failed", { message: deleteError })}</p>
      ) : null}
    </article>
  );
}
