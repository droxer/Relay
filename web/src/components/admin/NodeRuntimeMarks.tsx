"use client";

import type { TFunction } from "i18next";
import type { AgentName, ControlPanelDaemonNodeRecord } from "../../types";
import { labelForExecutor } from "../../lib/agentDisplayNames";
import { RuntimeMark } from "../RuntimeMark";
import { runtimeNotReadyDetail, runtimeStateLabel } from "../computer/runtimeStateLabel";
import {
  agentStatusTone,
  isNodeOnline,
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
    runtimeNotReadyDetail(node, agent, disabled, t),
  ].filter(Boolean);
  return parts.join(" · ");
}

/** Named runtime statuses shared by the fleet grid and list. */
export function NodeRuntimeMarks({
  node,
  slots,
  t,
}: {
  node: ControlPanelDaemonNodeRecord;
  /** Fixed runtime columns: a slot this computer lacks keeps its width empty,
      so the next runtime does not slide into it and the list's columns line
      up down the table. Omitted, only this computer's runtimes are drawn. */
  slots?: readonly AgentName[];
  t: TFunction;
}) {
  const agents = visibleNodeAgentNames(node);
  if (agents.length === 0) {
    return <span className="adm-agents-empty">{t("admin.v2.node_hosted_agents_empty")}</span>;
  }
  return (
    <span className="adm-node-runtimes-marks" data-slotted={slots ? "true" : undefined}>
      {(slots ?? agents).map((name) => {
        if (!agents.includes(name)) {
          return <span key={name} className="adm-runtime-readout is-empty" aria-hidden="true" />;
        }
        const agentStatus = node.agents[name] ?? "unknown";
        const disabled = isAgentDisabled(node, name);
        const presence = nodeAgentPresence(node, name);
        const tone = agentStatusTone(!isNodeOnline(node) && agentStatus !== "failed" ? "unknown" : agentStatus, { disabled });
        const stateLabel = runtimeStateLabel(node, name, disabled, t);
        return (
          <span key={name} className="adm-runtime-readout" title={agentTitle(node, name, t)}>
            <span className="adm-runtime-name" translate="no">{labelForExecutor(name)}</span>
            <RuntimeMark
              agent={name}
              presence={presence}
              tone={tone}
              variant="labeled"
              role="img"
              aria-label={stateLabel}
              title={stateLabel}
            />
          </span>
        );
      })}
    </span>
  );
}
