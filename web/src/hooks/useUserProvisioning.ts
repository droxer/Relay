import { useCallback } from "react";
import { provisionSandbox } from "../api";
import type { ControlPanelDaemonNodeRecord, DaemonNodeMonitorRecord, SandboxRecord } from "../types";
import { newBrowserSandboxToken } from "../lib/controlPanel";
import { shouldClaimLocalDaemonNode } from "../lib/daemonNodes";
import { useRelayStore } from "../lib/store";

export function useUserProvisioning({ nodes, refreshLocalDaemonNodes, refreshWithToken }: {
  nodes: DaemonNodeMonitorRecord[];
  refreshLocalDaemonNodes: () => Promise<ControlPanelDaemonNodeRecord[]>;
  refreshWithToken: (tokenOverride?: string) => Promise<void>;
}): {
  adoptLocalDaemonNodes: () => Promise<void>;
} {
  const tokens = useRelayStore((s) => s.tokens);
  const selectedUser = useRelayStore((s) => s.selectedUser);
  const setTokens = useRelayStore((s) => s.setTokens);

  const adoptLocalDaemonNodes = useCallback(async () => {
    const controlPanelNodes = (await refreshLocalDaemonNodes()) ?? [];
    const claimable = controlPanelNodes.filter((node) => shouldClaimLocalDaemonNode(node, nodes));
    if (claimable.length === 0) return;

    const nextTokens = { ...tokens };
    const adoptedSandboxes: SandboxRecord[] = [];
    for (const node of claimable) {
      if (!node.userId || !node.nodeToken) continue;
      const uiToken = newBrowserSandboxToken();
      try {
        const sandbox = await provisionSandbox(node.userId, uiToken, node.nodeToken);
        nextTokens[node.userId] = uiToken;
        nextTokens[sandbox.id] = uiToken;
        adoptedSandboxes.push(sandbox);
      } catch {
        // A node may already belong to another browser token; leave it untouched.
      }
    }

    if (adoptedSandboxes.length === 0) return;
    setTokens(nextTokens);
    await refreshWithToken(nextTokens[selectedUser] ?? nextTokens[adoptedSandboxes[0].id]);
  }, [nodes, refreshLocalDaemonNodes, refreshWithToken, selectedUser, setTokens, tokens]);

  return { adoptLocalDaemonNodes };
}
