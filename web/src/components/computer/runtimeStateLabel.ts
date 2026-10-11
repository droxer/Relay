import type { TFunction } from "i18next";
import type { AgentName, ControlPanelDaemonNodeRecord } from "../../types";
import { isNodeOnline } from "../admin/helpers";

/**
 * The one sentence a runtime row says about an agent on a computer — shared by
 * the computer card's Runtimes list and the Manage agents drawer so the two
 * never disagree about the same runtime.
 *
 * "Unknown" is accurate and unhelpful on a runtime the reader is trying to
 * use; say what it means instead. On a computer that has gone dark, the
 * daemon's last "ready" is a memory, not an offer — the row says Offline
 * rather than repeating a readiness the machine can no longer honour. A broken
 * runtime outlives the machine being off — it is still what the reader has to
 * fix when they power it back on.
 */
export function runtimeStateLabel(
  node: ControlPanelDaemonNodeRecord,
  agent: AgentName,
  disabled: boolean,
  t: TFunction,
): string {
  const agentStatus = node.agents[agent] ?? "unknown";
  if (disabled) return t("admin.v2.agent_disabled");
  if (agentStatus === "failed") return t("status.failed", { defaultValue: "failed" });
  if (!isNodeOnline(node)) return t("nodes.presence_offline");
  if (agentStatus === "unknown") return t("computer.runtime_no_signal");
  return t(`status.${agentStatus}`, { defaultValue: agentStatus });
}
