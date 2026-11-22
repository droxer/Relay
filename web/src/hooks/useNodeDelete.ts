"use client";

import { useState } from "react";
import type { TFunction } from "i18next";
import type { ControlPanelDaemonNodeRecord } from "../types";
import { useDialogs } from "@/components/ui/DialogProvider";
import { computerName } from "../lib/computerNodes";

/** The danger confirm for deleting a computer: named the way every other
 *  surface names it, with the id only when the computer has no name. */
export function nodeDeleteConfirm(node: ControlPanelDaemonNodeRecord, t: TFunction) {
  return {
    title: t("admin.v2.delete_confirm", { name: computerName(node) ?? node.id }),
    message: t("admin.v2.delete_message"),
    confirmLabel: t("admin.v2.delete_action"),
    tone: "danger" as const,
  };
}

/** Shared delete-confirm/pending/error flow for node surfaces (NodeRow, NodeCard). */
export function useNodeDelete(
  node: ControlPanelDaemonNodeRecord,
  onDelete: ((node: ControlPanelDaemonNodeRecord) => Promise<void>) | undefined,
  t: TFunction,
) {
  const { confirm } = useDialogs();
  const [deletePending, setDeletePending] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  async function handleDelete() {
    if (!onDelete) return;
    const ok = await confirm(nodeDeleteConfirm(node, t));
    if (!ok) return;
    setDeletePending(true);
    setDeleteError(null);
    try {
      await onDelete(node);
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : String(error));
    } finally {
      setDeletePending(false);
    }
  }

  return { deletePending, deleteError, handleDelete };
}
