"use client";

import { useId, useState } from "react";
import type { TFunction } from "i18next";
import type { AgentName, ControlPanelDaemonNodeRecord } from "../../types";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { RuntimeMark } from "../RuntimeMark";
import { ChevronDownIcon, ICON } from "../icons";
import { labelForExecutor } from "../../lib/agentDisplayNames";
import { runtimeStateLabel } from "../computer/runtimeStateLabel";
import { agentStatusTone, nodeAgentPresence } from "./helpers";

interface ManageAgentRowProps {
  node: ControlPanelDaemonNodeRecord;
  agent: AgentName;
  /** Saved state — what the computer is doing right now. */
  savedEnabled: boolean;
  /** Pending state — what Save will write. */
  enabled: boolean;
  saving: boolean;
  onToggle: (agent: AgentName) => void;
  t: TFunction;
}

/**
 * One runtime on the computer, in the same words the card's Runtimes list
 * uses (shared mark, name, state label), plus the switch that stages a change
 * and the agent's installed skills/MCP behind a disclosure. The inventory used
 * to be printed in full on every row, which made a computer with one
 * well-equipped agent read as a wall of pills; the count is what the reader
 * scans, the names are what they open.
 */
export function ManageAgentRow({ node, agent, savedEnabled, enabled, saving, onToggle, t }: ManageAgentRowProps) {
  const [expanded, setExpanded] = useState(false);
  const inventoryId = useId();
  const agentStatus = node.agents[agent] ?? "unknown";
  const savedDisabled = !savedEnabled;
  const tone = agentStatusTone(agentStatus, { disabled: savedDisabled });
  const presence = nodeAgentPresence(node, agent);
  const name = labelForExecutor(agent);
  const version = node.agentDetails?.[agent]?.version;
  const pending = enabled !== savedEnabled;
  const stateParts = [
    runtimeStateLabel(node, agent, savedDisabled, t),
    ...(version ? [version] : []),
  ];

  const inventory = node.agentInventory?.[agent];
  const skills = inventory?.skills ?? [];
  const mcpServers = inventory?.mcpServers ?? [];
  const inventorySummary = [
    ...(skills.length > 0 ? [t("admin.v2.agent_skill_count", { count: skills.length })] : []),
    ...(mcpServers.length > 0 ? [t("admin.v2.agent_mcp_count", { count: mcpServers.length })] : []),
  ].join(" · ");

  return (
    <li
      className="adm-agent-toggle-item"
      data-enabled={enabled ? "true" : "false"}
      data-pending={pending ? "true" : undefined}
    >
      <div className="adm-agent-toggle-row">
        <RuntimeMark
          agent={agent}
          presence={presence}
          tone={tone}
          variant="labeled"
          className="adm-agent-toggle-mark"
        />
        <div className="adm-agent-toggle-meta">
          <span className="adm-agent-toggle-name" translate="no">{name}</span>
          <span className="adm-agent-toggle-state">
            <span className="adm-agent-toggle-state-text">{stateParts.join(" · ")}</span>
            {pending ? (
              <span className="adm-agent-toggle-pending">
                {enabled ? t("admin.v2.agent_pending_enable") : t("admin.v2.agent_pending_disable")}
              </span>
            ) : null}
          </span>
        </div>
        <Switch
          name={`node-${node.id}-${agent}-enabled`}
          checked={enabled}
          onCheckedChange={() => onToggle(agent)}
          disabled={saving}
          aria-label={enabled
            ? t("admin.v2.disable_agent", { agent: name })
            : t("admin.v2.enable_agent", { agent: name })}
        />
      </div>
      {inventorySummary ? (
        <>
          <button
            type="button"
            className="adm-agent-inventory-toggle"
            aria-expanded={expanded}
            aria-controls={inventoryId}
            onClick={() => setExpanded((open) => !open)}
          >
            {inventorySummary}
            <ChevronDownIcon size={ICON.xs} aria-hidden="true" className="adm-agent-inventory-chevron" />
          </button>
          {expanded ? (
            <div id={inventoryId} className="adm-agent-inventory">
              {skills.length > 0 ? (
                <InventoryGroup label={t("admin.v2.agent_skills", { count: skills.length })}>
                  {skills.map((skill) => (
                    <Badge key={`${skill.namespace ?? ""}/${skill.name}`} className="adm-agent-inventory-pill code" title={skill.description ?? skill.name}>
                      {skill.name}
                    </Badge>
                  ))}
                </InventoryGroup>
              ) : null}
              {mcpServers.length > 0 ? (
                <InventoryGroup label={t("admin.v2.agent_mcp", { count: mcpServers.length })}>
                  {mcpServers.map((server) => (
                    <Badge key={server.name} className="adm-agent-inventory-pill code" title={server.command ?? server.name}>
                      {server.name}
                    </Badge>
                  ))}
                </InventoryGroup>
              ) : null}
            </div>
          ) : null}
        </>
      ) : null}
    </li>
  );
}

function InventoryGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="adm-agent-inventory-group">
      <span className="adm-agent-inventory-label">{label}</span>
      <span className="adm-agent-inventory-pills">{children}</span>
    </div>
  );
}
