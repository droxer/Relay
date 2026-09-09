"use client";

import { useState } from "react";
import type { TFunction } from "i18next";
import type { ControlPanelDaemonNodeRecord } from "../../types";
import { useNodeDelete } from "../../hooks/useNodeDelete";
import {
  COPY_FEEDBACK_MS,
  copyText,
  statusTone,
  visualStatus,
  type StoredNodeTokenMap,
} from "./helpers";
import { NodeActions } from "./NodeActions";
import { NodeProfileBadges } from "./NodeProfileBadges";
import { NodePresence } from "./NodePresence";
import { NodeRuntimeMarks } from "./NodeRuntimeMarks";
import { TonePill } from "../StatusPill";
import { Button } from "@/components/ui/button";
import {
  ActionApprove,
  ActionCopy,
  AdminEmployees,
  ICON,
  nodeOwnershipIcon,
} from "../icons";
import { isNodeOnline, nodeOwnershipProfile } from "../../lib/adminHelpers";

interface NodeCardProps {
  node: ControlPanelDaemonNodeRecord;
  employeeName?: string;
  storedTokens?: StoredNodeTokenMap;
  colocated?: boolean;
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
  employeeName,
  storedTokens = {},
  colocated = false,
  onReveal,
  onRename,
  onManageExecutors,
  onDelete,
  highlight = false,
  t,
}: NodeCardProps) {
  const [copied, setCopied] = useState(false);
  const { deletePending, deleteError, handleDelete } = useNodeDelete(node, onDelete, t);

  async function handleCopyId() {
    await copyText(node.id);
    setCopied(true);
    window.setTimeout(() => setCopied(false), COPY_FEEDBACK_MS);
  }

  const hasName = Boolean(node.displayName);
  const nodeName = hasName ? node.displayName! : node.id;
  // Only show the id handle when it adds information — a node whose display
  // name is (or equals) its id would otherwise print the same string twice.
  const showHandle = hasName && node.id !== nodeName;
  const status = visualStatus(node);
  const tone = statusTone(status);
  const statusLabel = t(`status.${status}`, { defaultValue: status });
  const online = isNodeOnline(node);
  // The presence pill already says Online/Offline, so the status pill only
  // renders when it adds state presence can't: running, provisioning,
  // failed, stopped.
  const showStatusPill = status !== "ready" && status !== "stale";
  const ownership = nodeOwnershipProfile(node);
  const OwnershipMark = nodeOwnershipIcon(ownership);

  return (
    <article
      className={`adm-node-card${highlight ? " is-pulse" : ""}`}
      data-online={online ? "true" : "false"}
    >
      <header className="adm-node-card-head">
        <span
          className="adm-node-avatar adm-node-avatar--machine"
          data-ownership={ownership}
          translate="no"
        >
          <OwnershipMark size={ICON.lg} aria-hidden="true" />
        </span>
        <div className="adm-node-card-identity">
          <span className="adm-node-card-nameline">
            <span
              className={`adm-node-card-name${hasName ? "" : " code"}`}
              translate="no"
            >
              {nodeName}
            </span>
            <NodePresence node={node} t={t} withLabel />
          </span>
          <span
            className={`adm-node-card-handle code${showHandle ? "" : " is-placeholder"}`}
            aria-hidden={showHandle ? undefined : true}
            translate="no"
          >
            {showHandle ? node.id : "\u00a0"}
          </span>
        </div>
        {showStatusPill ? (
          <TonePill tone={tone} label={statusLabel} live={status === "running" || status === "busy"} />
        ) : null}
      </header>

      <NodeProfileBadges
        node={node}
        storedTokens={storedTokens}
        colocated={colocated}
        t={t}
        card
        hideThisHost
        hideSavedHere
      />

      {employeeName ? (
        <div className="adm-node-card-employee-badge" title={employeeName} translate="no">
          <AdminEmployees size={ICON.xs} className="adm-node-card-employee-icon" aria-hidden="true" />
          <span className="adm-node-card-employee-badge-text">{employeeName}</span>
        </div>
      ) : null}

      <div className="adm-node-card-body">
        <div className="adm-node-runtimes" title={t("admin.v2.node_runtimes")}>
          <NodeRuntimeMarks node={node} t={t} />
        </div>
      </div>

      <footer className="adm-node-card-foot">
        {node.queuedCommandCount > 0 ? (
          <span className="adm-node-card-queued tnum">{node.queuedCommandCount} {t("admin.queued")}</span>
        ) : null}
        <div className="adm-node-card-actions">
          <Button variant="icon"
            size="icon-dense"
            tinted
            type="button"
            className="adm-node-card-icon-btn adm-node-action--copy"
            onClick={() => void handleCopyId()}
            aria-label={copied ? t("admin.copied") : t("admin.copy_node_id")}
            tooltip={node.id}
          >
            {copied ? <ActionApprove size={ICON.sm} aria-hidden="true" /> : <ActionCopy size={ICON.sm} aria-hidden="true" />}
          </Button>
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
      </footer>
      {deleteError ? (
        <p className="adm-node-card-error" role="alert">{t("admin.v2.action_failed", { message: deleteError })}</p>
      ) : null}
    </article>
  );
}
