"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  disabledSetsEqual,
  newlyDisabledReadyAgents,
  normalizeDisabledAgentsPayload,
  shouldSnapshotDisabledAgents,
} from "../../lib/manageExecutors";
import { AGENT_NAMES } from "../../types";
import type { AgentName, ControlPanelDaemonNodeRecord } from "../../types";
import { useDialogs } from "@/components/ui/DialogProvider";
import { Button } from "@/components/ui/button";
import { Drawer } from "@/components/ui/Drawer";
import { Alert } from "@/components/ui/alert";
import { visibleNodeAgentNames } from "./helpers";
import { abbreviateNodeId } from "../../lib/computerNodes";
import { useUnsavedChangesGuard } from "@/hooks/useUnsavedChangesGuard";
import { ManageAgentRow } from "./ManageAgentRow";
import { labelForExecutor } from "../../lib/agentDisplayNames";

interface ManageExecutorsDrawerProps {
  open: boolean;
  onClose: () => void;
  node: ControlPanelDaemonNodeRecord | null;
  /** The assigned user's @handle; the node carries only an id. */
  userHandle?: string;
  onUpdated: (node: ControlPanelDaemonNodeRecord) => void;
  onSave: (nodeId: string, disabledAgents: AgentName[]) => Promise<{ node: ControlPanelDaemonNodeRecord }>;
}

export function ManageExecutorsDrawer({ open, onClose, node, userHandle, onUpdated, onSave }: ManageExecutorsDrawerProps) {
  const { t } = useTranslation();
  const { confirm } = useDialogs();
  const [initialDisabled, setInitialDisabled] = useState<Set<AgentName>>(() => new Set());
  const [disabled, setDisabled] = useState<Set<AgentName>>(() => new Set());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Snapshot the saved state when the drawer opens or the target node changes.
  // Intentionally NOT depending on node.disabledAgents identity — the admin
  // node poll replaces the array every 2s, which would wipe pending toggles.
  const nodeId = node?.id ?? null;
  const previousNodeIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!shouldSnapshotDisabledAgents(open, previousNodeIdRef.current, nodeId)) {
      if (!open) previousNodeIdRef.current = null;
      return;
    }
    previousNodeIdRef.current = nodeId;
    const snapshot = new Set((node?.disabledAgents ?? []) as AgentName[]);
    setInitialDisabled(snapshot);
    setDisabled(new Set(snapshot));
    setError(null);
    setSaving(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, nodeId]);

  const dirty = !disabledSetsEqual(disabled, initialDisabled);
  const confirmDiscardChanges = useUnsavedChangesGuard(open && dirty && !saving);

  async function requestClose() {
    if (saving) return;
    if (await confirmDiscardChanges()) onClose();
  }

  function toggle(agent: AgentName) {
    setDisabled((prev) => {
      const next = new Set(prev);
      if (next.has(agent)) next.delete(agent);
      else next.add(agent);
      return next;
    });
  }

  async function handleSave() {
    if (!node) return;
    const newlyDisabledReady = newlyDisabledReadyAgents(
      initialDisabled,
      disabled,
      node.agents,
    );
    if (newlyDisabledReady.length > 0) {
      const ok = await confirm({
        title: t("admin.v2.manage_executors_disable_confirm", {
          agents: newlyDisabledReady.map((agent) => labelForExecutor(agent)).join(", "),
        }),
        message: t("admin.v2.manage_executors_disable_message"),
        confirmLabel: t("admin.v2.save_agent_settings"),
        tone: "danger",
      });
      if (!ok) return;
    }
    setSaving(true);
    setError(null);
    try {
      let updatedNode = node;
      if (!disabledSetsEqual(disabled, initialDisabled)) {
        const result = await onSave(
          node.id,
          normalizeDisabledAgentsPayload(disabled),
        );
        updatedNode = result.node;
      }
      onUpdated(updatedNode);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  if (!node) {
    return (
      <Drawer
        open={open}
        onClose={onClose}
        title={t("admin.v2.manage_executors_title")}
        closeLabel={t("drawer.close")}
        layer={1}
      >
        <p className="adm-cred-empty">{t("admin.v2.no_node_selected")}</p>
      </Drawer>
    );
  }

  // The card's Runtimes list, in its order — plus anything switched off here,
  // so a hidden runtime the reader disabled can still be switched back on.
  const visible = visibleNodeAgentNames(node);
  const agents = [...visible, ...AGENT_NAMES.filter((agent) => !visible.includes(agent) && initialDisabled.has(agent))];
  // Name the computer, not its id. An owner handle is only shown when the
  // caller resolved one (the admin console); never render a raw user id.
  const computerName = node.displayName?.trim() || abbreviateNodeId(node.id);
  const subtitle = userHandle ? `${computerName} · @${userHandle}` : computerName;

  return (
    <Drawer
      open={open}
      onClose={() => { void requestClose(); }}
      title={t("admin.v2.manage_executors_title")}
      subtitle={subtitle}
      closeLabel={t("drawer.close")}
      layer={1}
      width="detail"
      bodyClassName="adm-drawer-body--column"
    >
      <div className="adm-form">
        <p className="adm-cred-note adm-agent-drawer-note">{t("admin.v2.manage_executors_help")}</p>
        <ul className="adm-agent-toggle-list">
          {agents.map((agent) => (
            <ManageAgentRow
              key={agent}
              node={node}
              agent={agent}
              savedEnabled={!initialDisabled.has(agent)}
              enabled={!disabled.has(agent)}
              saving={saving}
              onToggle={toggle}
              t={t}
            />
          ))}
        </ul>
        {error ? (
          <Alert variant="boxed">{t("admin.v2.action_failed", { message: error })}</Alert>
        ) : null}
        <div className="adm-form-actions">
          <Button size="cta" type="button" variant="ghost" onClick={() => void requestClose()} disabled={saving}>
            {t("admin.v2.cancel")}
          </Button>
          <Button size="cta" type="button" onClick={() => void handleSave()} loading={saving} disabled={!dirty}>
            {saving ? t("admin.v2.saving") : t("admin.v2.save_agent_settings")}
          </Button>
        </div>
      </div>
    </Drawer>
  );
}
