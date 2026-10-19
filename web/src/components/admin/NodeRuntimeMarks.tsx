"use client";

import type { TFunction } from "i18next";
import type { AgentName, ControlPanelDaemonNodeRecord } from "../../types";
import { RuntimeMark } from "../RuntimeMark";
import { runtimeNotReadyDetail, runtimeStateLabel } from "../computer/runtimeStateLabel";
import {
  agentStatusTone,
  nodeAgentPresence,
  runtimeStatusLabel,
  visibleNodeAgentNames,
} from "../../lib/adminHelpers";

function isAgentDisabled(node: ControlPanelDaemonNodeRecord, agent: AgentName): boolean {
  return Boolean(node.disabledAgents?.includes(agent));
}

function agentTitle(node: ControlPanelDaemonNodeRecord, agent: AgentName, t: TFunction): string {
  const disabled = isAgentDisabled(node, agent);
  const state = runtimeStateLabel(node, agent, disabled, t);
  const reported = runtimeStatusLabel(node.agents[agent] ?? "unknown", t);
  const parts = [
    // The same words the computer card uses: "Not installed" on a live
    // computer, never a bare "Offline" beside it. On a dark computer the
    // state is Offline, so the last report follows as what it said.
    t("nodes.agent_presence_title", { agent, presence: state }),
    !disabled && state !== reported ? t("nodes.agent_status_title", { agent, status: reported }) : null,
    node.agentDetails?.[agent]?.version,
    runtimeNotReadyDetail(node, agent, disabled),
  ].filter(Boolean);
  return parts.join(" · ");
}

/**
 * The executor glyph row shared by the fleet card and the fleet list row.
 *
 * Each mark carries its agent's presence as shape: a filled dot is an agent
 * that can take work right now, a hollow ring is one that cannot — because its
 * computer is dark, because the daemon never reported it ready, or because it
 * failed. Hue then says which of those it is. Presence is also spelled out for
 * assistive tech, so the cue is not shape-only.
 */
export function NodeRuntimeMarks({
  node,
  t,
}: {
  node: ControlPanelDaemonNodeRecord;
  t: TFunction;
}) {
  const agents = visibleNodeAgentNames(node);
  if (agents.length === 0) {
    return <span className="adm-agents-empty">{t("admin.v2.node_hosted_agents_empty")}</span>;
  }
  return (
    <span className="adm-node-runtimes-marks">
      {agents.map((name) => {
        const agentStatus = node.agents[name] ?? "unknown";
        const disabled = isAgentDisabled(node, name);
        const presence = nodeAgentPresence(node, name);
        return (
          <RuntimeMark
            key={name}
            agent={name}
            presence={presence}
            tone={agentStatusTone(agentStatus, { disabled })}
            disabled={disabled}
            glyphClassName="adm-agent-chip-mark"
            role="img"
            aria-label={`${name} · ${runtimeStateLabel(node, name, disabled, t)}`}
            title={agentTitle(node, name, t)}
            translate="no"
          />
        );
      })}
    </span>
  );
}
