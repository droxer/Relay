import type { TFunction } from "i18next";
import type { AgentName, ControlPanelDaemonNodeRecord } from "../../types";
import { isNodeOnline, runtimeStatusLabel } from "../admin/helpers";

/**
 * The one sentence a runtime row says about an agent on a computer — shared by
 * the computer card's Runtimes list, the Manage agents drawer, and the fleet
 * marks' titles so they never disagree about the same runtime.
 *
 * Each non-ready status names what the check established: a failed check
 * needs its diagnostic inspected, a missing CLI needs installing, and one
 * that stopped responding needs a look at the computer. "Unknown" is accurate
 * and unhelpful, so it says there is no signal yet.
 *
 * On a computer that has gone dark, the daemon's last "ready" (or "not
 * responding") is a memory, not an offer — the row says Offline rather than
 * repeating a state the machine can no longer vouch for. A failed check,
 * or a missing installation, outlives the machine being off — it is
 * still what the reader has to fix when they power it back on.
 */
export function runtimeStateLabel(
  node: ControlPanelDaemonNodeRecord,
  agent: AgentName,
  disabled: boolean,
  t: TFunction,
): string {
  const agentStatus = node.agents[agent] ?? "unknown";
  if (disabled) return t("admin.v2.agent_disabled");
  if (agentStatus === "failed" || agentStatus === "unavailable") return runtimeStatusLabel(agentStatus, t);
  if (!isNodeOnline(node)) return t("nodes.presence_offline");
  return runtimeStatusLabel(agentStatus, t);
}

/** Localized interface guidance; daemon prose belongs in the diagnostics disclosure. */
export function runtimeNotReadyDetail(
  node: ControlPanelDaemonNodeRecord,
  agent: AgentName,
  disabled: boolean,
  t: TFunction,
): string | undefined {
  const status = node.agents[agent] ?? "unknown";
  if (disabled || status === "ready") return undefined;
  switch (status) {
    case "unavailable": return t("computer.runtime_detail_unavailable");
    case "unresponsive": return t("computer.runtime_detail_unresponsive");
    case "failed": return t("computer.runtime_detail_failed");
    default: return t("computer.runtime_detail_unknown");
  }
}
