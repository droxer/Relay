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

/** `base` with every agent in `toggles` flipped. */
function toggledFrom(base: Set<AgentName>, toggles: Set<AgentName>): Set<AgentName> {
  const next = new Set(base);
  for (const agent of toggles) {
    if (next.has(agent)) next.delete(agent);
    else next.add(agent);
  }
  return next;
}

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

  // Snapshot the saved state when the drawer opens, when it targets another
  // node, and once more when a node opened before its saved state loaded
  // (`disabledAgents` absent) finally reports one.
  const nodeId = node?.id ?? null;
  const savedDisabled = node?.disabledAgents;
  const hasSavedState = savedDisabled !== undefined;
  const snapshotRef = useRef<{ nodeId: string | null; hasSavedState: boolean }>({
    nodeId: null,
    hasSavedState: false,
  });
  useEffect(() => {
    const previous = snapshotRef.current;
    const isNewTarget = shouldSnapshotDisabledAgents(open, previous.nodeId, nodeId);
    const savedStateArrived = open && nodeId !== null && !isNewTarget && !previous.hasSavedState && hasSavedState;
    if (!isNewTarget && !savedStateArrived) {
      if (!open) snapshotRef.current = { nodeId: null, hasSavedState: false };
      return;
    }
    snapshotRef.current = { nodeId, hasSavedState };
    const snapshot = new Set((savedDisabled ?? []) as AgentName[]);
    setInitialDisabled(snapshot);
    if (savedStateArrived) {
      // The placeholder baseline was empty, so everything in `prev` is a
      // toggle the reader already made: replay those toggles onto the real
      // baseline rather than discarding them.
      setDisabled((prev) => toggledFrom(snapshot, prev));
      return;
    }
    setDisabled(new Set(snapshot));
    setError(null);
    setSaving(false);
    // Deliberately keyed on `hasSavedState`, not `savedDisabled`: the admin
    // node poll hands over a fresh `disabledAgents` array every couple of
    // seconds, and re-snapshotting on that identity would wipe the reader's
    // pending toggles. The array is read only on the transitions above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, nodeId, hasSavedState]);

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
