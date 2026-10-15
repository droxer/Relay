"use client";

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { handleForUserId } from "../../lib/userHandle";
import { Button } from "@/components/ui/button";
import { useDialogs } from "@/components/ui/DialogProvider";
import { formatRelativeTime } from "../../lib/adminHelpers";
import { managedNodeHistory } from "../../lib/managedNodeHistory";
import type { UserRecord, ManagedNodeRecord } from "../../types";
import {
  AdminDelete,
  AdminNode,
  AdminRestore,
  ICON,
} from "../icons";

interface ManagedNodeHistoryProps {
  nodes: ManagedNodeRecord[];
  /** The roster, so a computer's user id can be shown as its @handle. */
  users: UserRecord[];
  onRecover: (node: ManagedNodeRecord) => Promise<void>;
  onDeletePermanently: (node: ManagedNodeRecord) => Promise<void>;
}

type PendingAction = { id: string; kind: "recover" | "delete" } | null;

export function ManagedNodeHistory({ nodes, users, onRecover, onDeletePermanently }: ManagedNodeHistoryProps) {
  const { t } = useTranslation();
  const { confirm } = useDialogs();
  const [pending, setPending] = useState<PendingAction>(null);
  const [error, setError] = useState<string | null>(null);
  const historical = managedNodeHistory(nodes);

  if (historical.length === 0) return null;

  async function handleRecover(node: ManagedNodeRecord) {
    const accepted = await confirm({
      title: t("admin.v2.history_recover_confirm", { name: node.displayName, id: node.id }),
      message: t("admin.v2.history_recover_message"),
      confirmLabel: t("admin.v2.history_recover_action"),
    });
    if (!accepted) return;
    setPending({ id: node.id, kind: "recover" });
    setError(null);
    try {
      await onRecover(node);
    } catch (recoverError) {
      setError(recoverError instanceof Error ? recoverError.message : String(recoverError));
    } finally {
      setPending(null);
    }
  }

  async function handleDelete(node: ManagedNodeRecord) {
    const accepted = await confirm({
      title: t("admin.v2.history_delete_confirm", { name: node.displayName, id: node.id }),
      message: t("admin.v2.history_delete_warning"),
      confirmLabel: t("admin.v2.history_delete_action"),
      tone: "danger",
    });
    if (!accepted) return;
    setPending({ id: node.id, kind: "delete" });
    setError(null);
    try {
      await onDeletePermanently(node);
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : String(deleteError));
    } finally {
      setPending(null);
    }
  }

  return (
    <section className="adm-node-history" aria-labelledby="managed-node-history-title">
      <header className="adm-node-history-head">
        <div className="adm-node-history-title-row">
          <h2 id="managed-node-history-title">{t("admin.v2.history_title")}</h2>
          <span
            className="adm-node-history-count tnum"
            aria-label={t("admin.v2.history_count", { count: historical.length })}
          >
            {historical.length}
          </span>
        </div>
        <p>{t("admin.v2.history_description")}</p>
      </header>

      <ul className="adm-node-history-list" data-density="compact">
        {historical.map((node) => (
          <li key={node.id} className="adm-node-history-row">
            <span className="adm-node-history-icon" aria-hidden="true">
              <AdminNode size={ICON.md} />
            </span>
            <span className="adm-node-history-identity">
              <strong>{node.displayName}</strong>
              <span className="code">{node.id}</span>
            </span>
            <span className="adm-node-history-meta">
              {node.userId ? `@${handleForUserId(users, node.userId)} · ` : ""}{node.provider} · {node.profile}
            </span>
            <time dateTime={node.updatedAt} title={node.updatedAt}>
              {t("admin.v2.history_deleted", { time: formatRelativeTime(node.updatedAt, t) })}
            </time>
            <Button
              variant="outline"
              type="button"
              className="adm-node-history-recover"
              disabled={pending?.id === node.id}
              onClick={() => void handleRecover(node)}
            >
              <AdminRestore size={ICON.sm} aria-hidden="true" />
              {pending?.id === node.id && pending.kind === "recover"
                ? t("admin.v2.history_recovering")
                : t("admin.v2.history_recover_action")}
            </Button>
            <Button
              variant="destructive"
              type="button"
              className="adm-node-history-delete"
              disabled={pending?.id === node.id}
              onClick={() => void handleDelete(node)}
            >
              <AdminDelete size={ICON.sm} aria-hidden="true" />
              {pending?.id === node.id && pending.kind === "delete"
                ? t("admin.v2.history_deleting")
                : t("admin.v2.history_delete_action")}
            </Button>
          </li>
        ))}
      </ul>
      {error ? <p className="adm-node-history-error" role="alert">{t("admin.v2.action_failed", { message: error })}</p> : null}
    </section>
  );
}
