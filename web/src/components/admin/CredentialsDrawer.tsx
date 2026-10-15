"use client";

import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { ControlPanelDaemonNodeRecord } from "../../types";
import { useDialogs } from "@/components/ui/DialogProvider";
import { Button } from "@/components/ui/button";
import { Drawer } from "@/components/ui/Drawer";
import { CredCopyRow } from "./CredCopyRow";
import { NodeProfileBadges } from "./NodeProfileBadges";
import { resolveNodeCredentials, type StoredNodeToken } from "./helpers";
import { canUseLocalControlPanel } from "../../lib/controlPanel";
import { useCopyFeedback } from "@/hooks/useCopyFeedback";
import { Alert } from "@/components/ui/alert";

interface CredentialsDrawerProps {
  open: boolean;
  onClose: () => void;
  node: ControlPanelDaemonNodeRecord | null;
  storedToken?: StoredNodeToken;
  /** The assigned user's @handle. The node only carries an id, which is a
      UUID under the database auth store. */
  userHandle?: string;
  onUnassign?: (node: ControlPanelDaemonNodeRecord) => Promise<void>;
  onDelete?: (node: ControlPanelDaemonNodeRecord) => Promise<void>;
}

export function CredentialsDrawer({ open, onClose, node, storedToken, userHandle, onUnassign, onDelete }: CredentialsDrawerProps) {
  const { t } = useTranslation();
  const { confirm } = useDialogs();
  const { copiedField, copy } = useCopyFeedback();
  const [actionPending, setActionPending] = useState<"unassign" | "delete" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  async function runAction(kind: "unassign" | "delete", handler: () => Promise<void>) {
    setActionPending(kind);
    setActionError(null);
    try {
      await handler();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setActionPending(null);
    }
  }

  async function handleUnassign() {
    if (!node || !onUnassign) return;
    const user = userHandle || node.userId || "";
    const ok = await confirm({
      title: t("admin.v2.unassign_confirm", { user, id: node.id }),
      message: t("admin.v2.unassign_message"),
      confirmLabel: t("admin.v2.unassign_action"),
      tone: "danger",
    });
    if (!ok) return;
    void runAction("unassign", () => onUnassign(node));
  }

  async function handleDelete() {
    if (!node || !onDelete) return;
    const ok = await confirm({
      title: t("admin.v2.delete_confirm", { id: node.id }),
      message: t("admin.v2.delete_message"),
      confirmLabel: t("admin.v2.delete_action"),
      tone: "danger",
    });
    if (!ok) return;
    await runAction("delete", () => onDelete(node));
  }

  if (!node) {
    return (
      <Drawer
        open={open}
        onClose={onClose}
        title={t("admin.v2.credentials_title")}
        closeLabel={t("drawer.close")}
        layer={1}
        width="detail"
      >
        <p className="adm-cred-empty">{t("admin.v2.no_node_selected")}</p>
      </Drawer>
    );
  }

  const userLabel = node.userId
    ? `@${userHandle || node.userId}`
    : t("admin.unassigned");
  const credentials = resolveNodeCredentials(node, storedToken);
  const { sandboxToken, nodeToken, daemonCommand, source } = credentials;
  const token = nodeToken ?? sandboxToken;
  const hasCredentials = source !== "none";

  const credentialsNote = (() => {
    if (source === "cache") return t("admin.v2.credentials_from_cache");
    if (source === "server") return t("admin.v2.credentials_from_server");
    if (source === "cache+server") return t("admin.v2.credentials_from_cache_and_server");
    return null;
  })();

  const hasDangerZone = Boolean(onUnassign || onDelete);

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={t("admin.v2.credentials_title")}
      subtitle={`${userLabel} · ${node.id}`}
      subtitleMono
      closeLabel={t("drawer.close")}
      layer={1}
      width="detail"
      bodyClassName={hasDangerZone ? "adm-drawer-body--column" : undefined}
    >
      {/* .adm-form is unconditional — it owns the stack's vertical rhythm.
          Only the column layout is conditional, because only the danger-zone
          branch has a footer to anchor to the panel's bottom edge. */}
      <div className="adm-form">
        <NodeProfileBadges
          node={node}
          storedTokens={storedToken ? { [node.id]: storedToken } : {}}
          colocated={canUseLocalControlPanel()}
          t={t}
          compact
        />
        <CredCopyRow
          label={t("admin.node_id")}
          hint={t("admin.node_id_hint")}
          value={node.id}
          copyLabel={t("admin.copy_node_id")}
          copied={copiedField === "node-id"}
          onCopy={() => void copy("node-id", node.id)}
        />
        {hasCredentials ? (
          <>
            {token ? (
              <CredCopyRow
                label={t("admin.node_token")}
                value={token}
                copyLabel={t("admin.copy_node_token")}
                copied={copiedField === "node-token"}
                onCopy={() => void copy("node-token", token)}
              />
            ) : null}
            {daemonCommand ? (
              <CredCopyRow
                label={t("admin.daemon_command")}
                hint={t("admin.daemon_command_hint")}
                value={daemonCommand}
                copyLabel={t("admin.copy_daemon_command")}
                copied={copiedField === "command"}
                onCopy={() => void copy("command", daemonCommand)}
              />
            ) : null}
            {credentialsNote ? (
              <p className="adm-cred-note">{credentialsNote}</p>
            ) : (
              <p className="adm-cred-note">
                {t("admin.token_cached_note", { user: userLabel })}
              </p>
            )}
          </>
        ) : (
          <p className="adm-cred-empty">{t("admin.v2.token_only_at_provision")}</p>
        )}
        {hasDangerZone ? (
          <>
            <div className="adm-drawer-section">
              <h3 className="adm-drawer-section-title">{t("admin.v2.danger_zone")}</h3>
              <div className="adm-drawer-section-actions">
                {onUnassign && node.userId ? (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={handleUnassign}
                    disabled={actionPending !== null}
                    loading={actionPending === "unassign"}
                  >
                    {actionPending === "unassign" ? t("admin.v2.unassigning") : t("admin.v2.unassign_action")}
                  </Button>
                ) : null}
                {onDelete ? (
                  <Button
                    type="button"
                    variant="destructive"
                    onClick={handleDelete}
                    disabled={actionPending !== null}
                    loading={actionPending === "delete"}
                  >
                    {actionPending === "delete" ? t("admin.v2.deleting") : t("admin.v2.delete_action")}
                  </Button>
                ) : null}
              </div>
              {actionError ? (
                <Alert variant="boxed">{t("admin.v2.action_failed", { message: actionError })}</Alert>
              ) : null}
            </div>
            <div className="adm-form-actions">
              <Button size="cta" type="button" variant="ghost" onClick={onClose} disabled={actionPending !== null}>
                {t("admin.v2.close_drawer")}
              </Button>
            </div>
          </>
        ) : null}
      </div>
    </Drawer>
  );
}
