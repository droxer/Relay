"use client";

import type { TFunction } from "i18next";
import type { ControlPanelDaemonNodeRecord } from "../../types";
import { Button } from "@/components/ui/button";
import {
  ActionEdit,
  ActionKey,
  AdminDelete,
  AdminManageExecutors,
  ICON,
} from "../icons";

interface NodeActionsProps {
  node: ControlPanelDaemonNodeRecord;
  onReveal?: (node: ControlPanelDaemonNodeRecord) => void;
  onRename: (node: ControlPanelDaemonNodeRecord) => void;
  onManageExecutors: (node: ControlPanelDaemonNodeRecord) => void;
  onDelete?: (node: ControlPanelDaemonNodeRecord) => Promise<void>;
  deletePending: boolean;
  onDeleteRequest: () => void;
  t: TFunction;
}

/** Shared reveal/manage/delete icon-action trio for node surfaces (NodeRow, NodeCard). */
export function NodeActions({ node, onReveal, onRename, onManageExecutors, onDelete, deletePending, onDeleteRequest, t }: NodeActionsProps) {
  return (
    <>
      <Button
        variant="icon"
        size="icon-dense"
        tinted
        type="button"
        className="adm-node-card-icon-btn adm-node-action--rename"
        onClick={() => onRename(node)}
        aria-label={t("admin.v2.rename_computer_for", { id: node.id })}
        tooltip={t("thread.rename_computer")}
      >
        <ActionEdit size={ICON.sm} aria-hidden="true" />
      </Button>
      {node.managedNodeId || !onReveal ? null : (
        <Button
          variant="icon"
          size="icon-dense"
          tinted
          type="button"
          className="adm-node-card-icon-btn adm-node-action--credentials"
          onClick={() => onReveal(node)}
          aria-label={t("admin.v2.reveal_credentials_for", { id: node.id })}
          tooltip={t("admin.v2.reveal_credentials")}
        >
          <ActionKey size={ICON.sm} aria-hidden="true" />
        </Button>
      )}
      {!node.provisioningPlaceholder ? (
        <Button
          variant="icon"
          size="icon-dense"
          tinted
          type="button"
          className="adm-node-card-icon-btn adm-node-action--agents"
          onClick={() => onManageExecutors(node)}
          aria-label={t("admin.v2.manage_executors_for", { id: node.id })}
          tooltip={t("admin.v2.manage_executors")}
        >
          <AdminManageExecutors size={ICON.sm} aria-hidden="true" />
        </Button>
      ) : null}
      {onDelete ? (
        <Button
          variant="icon"
          size="icon-dense"
          tinted
          type="button"
          danger
          className="adm-node-card-icon-btn adm-node-action--delete"
          onClick={onDeleteRequest}
          disabled={deletePending}
          aria-label={t("admin.v2.delete_node_for", { id: node.id })}
          tooltip={t("admin.v2.delete_action")}
        >
          <AdminDelete size={ICON.sm} aria-hidden="true" />
        </Button>
      ) : null}
    </>
  );
}
