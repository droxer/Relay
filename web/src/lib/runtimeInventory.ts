import type { ControlPanelDaemonNodeRecord } from "../types";
import { AGENT_RUNTIME_DISPLAY_ORDER } from "./agentRuntimeOrder";
import { isNodeOnline } from "./adminHelpers";

/** One installation per computer/runtime; offline reports never count as ready. */
export function runtimeInventory(nodes: readonly ControlPanelDaemonNodeRecord[]) {
  return AGENT_RUNTIME_DISPLAY_ORDER.map((agent) => {
    let installed = 0;
    let ready = 0;
    let failed = 0;
    for (const node of nodes) {
      const status = node.agents[agent];
      if (!status || status === "unknown" || status === "unavailable") continue;
      installed++;
      if (node.disabledAgents?.includes(agent)) continue;
      if (status === "ready" && isNodeOnline(node)) ready++;
      if (status === "failed" || status === "unresponsive") failed++;
    }
    return { agent, installed, ready, failed };
  });
}
