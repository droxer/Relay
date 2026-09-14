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
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { StateMark } from "../StateMark";
import { AgentMark } from "../AgentMark";
import { Drawer } from "@/components/ui/Drawer";
import { agentStatusTone, nodeAgentPresence } from "./helpers";
import { NodeProfileBadges } from "./NodeProfileBadges";
import { useUnsavedChangesGuard } from "@/hooks/useUnsavedChangesGuard";
import { ICON } from "../icons";
import { Alert } from "@/components/ui/alert";

interface ManageExecutorsDrawerProps {
  open: boolean;
  onClose: () => void;
  node: ControlPanelDaemonNodeRecord | null;
  /** The assigned employee's @handle; the node carries only an id. */
  employeeHandle?: string;
  onUpdated: (node: ControlPanelDaemonNodeRecord) => void;
  onSave: (nodeId: string, disabledAgents: AgentName[]) => Promise<{ node: ControlPanelDaemonNodeRecord }>;
}

export function ManageExecutorsDrawer({ open, onClose, node, employeeHandle, onUpdated, onSave }: ManageExecutorsDrawerProps) {
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
          agents: newlyDisabledReady.join(", "),
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

  return (
    <Drawer
      open={open}
      onClose={() => { void requestClose(); }}
      title={t("admin.v2.manage_executors_title")}
      subtitle={`${node.employeeId ? `@${employeeHandle || node.employeeId}` : t("admin.unassigned")} · ${node.id}`}
      subtitleMono
      closeLabel={t("drawer.close")}
      layer={1}
      width="detail"
      bodyClassName="adm-drawer-body--column"
    >
      <div className="adm-form">
        <NodeProfileBadges
          node={node}
          storedTokens={{}}
          colocated={false}
          t={t}
          compact
        />
        <p className="adm-cred-note adm-agent-drawer-note">{t("admin.v2.manage_executors_help")}</p>
        <ul className="adm-agent-toggle-list">
        {AGENT_NAMES.map((agent) => {
          const agentStatus = node.agents[agent] ?? "unknown";
          const tone = agentStatusTone(agentStatus);
          const isEnabled = !disabled.has(agent);
          // Same rule as the node surfaces: a dark computer hosts no online
          // agents, so the chip must not keep advertising the last "ready".
          const presence = nodeAgentPresence(node, agent);
          const inventory = node.agentInventory?.[agent];
          const skills = inventory?.skills ?? [];
          const mcpServers = inventory?.mcpServers ?? [];
          return (
            <li
              key={agent}
              className={`adm-agent-toggle-item${isEnabled ? "" : " is-disabled"}`}
            >
              <div className="adm-agent-toggle-row">
                <div className="adm-agent-toggle-meta">
                  <span className="adm-agent-toggle-name" translate="no">
                    <AgentMark agent={agent} size={ICON.sm} className="adm-agent-toggle-mark" />
                    {agent}
                  </span>
                  {/* Shared Badge chrome + the shared status mark. The dot was
                      an `<i class="adm-agent-dot">` with its own ring rules —
                      the last surface still drawing its own 8px status circle
                      instead of going through StateMark, which is where the
                      tone → shape grammar (ring for bad, hollow for a dark
                      computer) is written down. */}
                  <Badge
                    variant="state"
                    className={`adm-agent-chip tone-${tone}`}
                    data-presence={presence}
                  >
                    <StateMark
                      tone={tone}
                      shape={presence === "offline" ? "ring" : undefined}
                    />
                    {presence === "offline" && agentStatus === "ready"
                      ? t("nodes.presence_offline")
                      : t(`status.${agentStatus}`, { defaultValue: agentStatus })}
                  </Badge>
                </div>
                <label className="adm-agent-toggle-switch">
                  <Switch
                    name={`node-${node.id}-${agent}-enabled`}
                    checked={isEnabled}
                    onCheckedChange={() => toggle(agent)}
                    disabled={saving}
                    aria-label={
                      isEnabled
                        ? t("admin.v2.disable_agent", { agent })
                        : t("admin.v2.enable_agent", { agent })
                    }
                  />
                  <span className="adm-agent-toggle-label">
                    {isEnabled ? t("admin.v2.agent_enabled") : t("admin.v2.agent_disabled")}
                  </span>
                </label>
              </div>
              <div className="adm-agent-inventory">
                {skills.length === 0 && mcpServers.length === 0 ? (
                  <span className="adm-agent-inventory-empty">{t("admin.v2.agent_no_inventory")}</span>
                ) : (
                  <>
                    {skills.length > 0 && (
                      <div className="adm-agent-inventory-group">
                        <span className="adm-agent-inventory-label">{t("admin.v2.agent_skills", { count: skills.length })}</span>
                        <span className="adm-agent-inventory-pills">
                          {skills.map((skill) => (
                            <Badge key={`${skill.namespace ?? ""}/${skill.name}`} className="adm-agent-inventory-pill code" title={skill.description ?? skill.name}>
                              {skill.name}
                            </Badge>
                          ))}
                        </span>
                      </div>
                    )}
                    {mcpServers.length > 0 && (
                      <div className="adm-agent-inventory-group">
                        <span className="adm-agent-inventory-label">{t("admin.v2.agent_mcp", { count: mcpServers.length })}</span>
                        <span className="adm-agent-inventory-pills">
                          {mcpServers.map((server) => (
                            <Badge key={server.name} className="adm-agent-inventory-pill code" title={server.command ?? server.name}>
                              {server.name}
                            </Badge>
                          ))}
                        </span>
                      </div>
                    )}
                  </>
                )}
              </div>
            </li>
          );
        })}
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
