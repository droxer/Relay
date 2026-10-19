import type { TFunction } from "i18next";
import type { AgentName, ControlPanelDaemonNodeRecord } from "../../types";
import { isNodeOnline, runtimeStatusLabel } from "../admin/helpers";

/**
 * The one sentence a runtime row says about an agent on a computer — shared by
 * the computer card's Runtimes list, the Manage agents drawer, and the fleet
 * marks' titles so they never disagree about the same runtime.
 *
 * Each non-ready status names what the reader has to do: a runtime that can't
 * connect needs signing in, one that is not installed needs installing, one
 * that stopped responding needs a look at the computer. "Unknown" is accurate
 * and unhelpful, so it says there is no signal yet.
 *
 * On a computer that has gone dark, the daemon's last "ready" (or "not
 * responding") is a memory, not an offer — the row says Offline rather than
 * repeating a state the machine can no longer vouch for. A runtime that can't
 * connect, or was never installed, outlives the machine being off — it is
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

/**
 * What the daemon said about a runtime that cannot take work — "`codex` was
 * not found on PATH", the sign-in error, the sandbox that did not start. A
 * ready or switched-off runtime has nothing to explain, so it says nothing.
 */
export function runtimeNotReadyDetail(
  node: ControlPanelDaemonNodeRecord,
  agent: AgentName,
  disabled: boolean,
): string | undefined {
  if (disabled || (node.agents[agent] ?? "unknown") === "ready") return undefined;
  return node.agentDetails?.[agent]?.detail?.trim() || undefined;
}
