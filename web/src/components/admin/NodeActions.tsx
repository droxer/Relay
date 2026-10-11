"use client";

import type { TFunction } from "i18next";
import type { ControlPanelDaemonNodeRecord } from "../../types";
import { Button } from "@/components/ui/button";
import { useDialogs } from "@/components/ui/DialogProvider";
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
  AdminDelete,
  AdminManageExecutors,
  ICON,
  NavMore,
} from "../icons";
import { copyText } from "./helpers";

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

/** One overflow menu for a computer on the fleet card and list row. The
    actions are occasional, so they stay labelled but out of sight until asked
    for — the same grammar as the personal Computers page. */
export function NodeActions({ node, onReveal, onRename, onManageExecutors, onDelete, deletePending, onDeleteRequest, t }: NodeActionsProps) {
  const { announce } = useDialogs();
  const name = node.displayName || node.id;
  const canReveal = Boolean(onReveal) && !node.managedNodeId;

  async function handleCopyId() {
    await copyText(node.id);
    announce(t("admin.copied"));
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            type="button"
            variant="icon"
            size="icon-dense"
            className="adm-node-actions-trigger"
            disabled={deletePending}
            aria-label={t("computer.more_actions", { name })}
            title={t("computer.more_actions", { name })}
          >
            <NavMore size={ICON.md} aria-hidden="true" />
          </Button>
        }
      />
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => void handleCopyId()}>
          <ActionCopy size={ICON.sm} aria-hidden="true" />
          {t("admin.copy_node_id")}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => onRename(node)}>
          <ActionEdit size={ICON.sm} aria-hidden="true" />
          {t("thread.rename_computer")}
        </DropdownMenuItem>
        {canReveal ? (
          <DropdownMenuItem onClick={() => onReveal?.(node)}>
            <ActionKey size={ICON.sm} aria-hidden="true" />
            {t("admin.v2.reveal_credentials")}
          </DropdownMenuItem>
        ) : null}
        {node.provisioningPlaceholder ? null : (
          <DropdownMenuItem onClick={() => onManageExecutors(node)}>
            <AdminManageExecutors size={ICON.sm} aria-hidden="true" />
            {t("admin.v2.manage_executors")}
          </DropdownMenuItem>
        )}
        {onDelete ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem danger onClick={onDeleteRequest}>
              <AdminDelete size={ICON.sm} aria-hidden="true" />
              {t("admin.v2.delete_action")}
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
