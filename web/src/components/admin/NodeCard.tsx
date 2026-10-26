"use client";

import type { TFunction } from "i18next";
import type { ControlPanelDaemonNodeRecord, UserRecord } from "../../types";
import { useNodeDelete } from "../../hooks/useNodeDelete";
import { statusTone, visualStatus } from "./helpers";
import { NodeActions } from "./NodeActions";
import { NodeMeta } from "./NodeMeta";
import { NodePresence } from "./NodePresence";
import { NodeRuntimeMarks } from "./NodeRuntimeMarks";
import { TonePill } from "../StatusPill";
import { ClientOutdatedBadge } from "../computer/ClientOutdatedBadge";
import { HostOsBadge } from "../computer/HostOsBadge";
import { isNodeOnline } from "../../lib/adminHelpers";

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

  const hasName = Boolean(node.displayName);
  const nodeName = hasName ? node.displayName! : node.id;
  // Only show the id handle when it adds information — a node whose display
  // name is (or equals) its id would otherwise print the same string twice.
  const showHandle = hasName && node.id !== nodeName;
  const status = visualStatus(node);
  const online = isNodeOnline(node);
  // ONE status readout per card. Presence (Online/Offline) is the ordinary
  // case; the lifecycle pill replaces it only when it says something presence
  // cannot — running, provisioning, failed, stopped. Showing both printed
  // "Running · Online" on every busy machine.
  const showStatusPill = status !== "ready" && status !== "stale";

  return (
    <article
      className={`adm-node-card${highlight ? " is-pulse" : ""}`}
      data-online={online ? "true" : "false"}
    >
      <header className="adm-node-card-head">
        <div className="adm-node-card-identity">
          <span
            className={`adm-node-card-name${hasName ? "" : " code"}`}
            translate="no"
            title={nodeName}
          >
            {nodeName}
          </span>
          {showHandle ? (
            <span className="adm-node-card-handle code" translate="no">{node.id}</span>
          ) : null}
          {/* The status rides under the name rather than beside it: beside
              it, a card narrower than name + status wrapped the status onto
              a line of its own, floated right next to the menu. */}
          <span className="adm-node-card-state">
            {showStatusPill ? (
              <TonePill
                className="adm-status-plain"
                tone={statusTone(status)}
                label={t(`status.${status}`, { defaultValue: status })}
                live={status === "running" || status === "busy"}
              />
            ) : (
              <NodePresence node={node} t={t} withLabel />
            )}
            <HostOsBadge node={node} />
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
        {node.queuedCommandCount > 0 ? (
          <span className="adm-node-card-queued tnum">{node.queuedCommandCount} {t("admin.queued")}</span>
        ) : null}
      </footer>
      {deleteError ? (
        <p className="adm-node-card-error" role="alert">{t("admin.v2.action_failed", { message: deleteError })}</p>
      ) : null}
    </article>
  );
}
