import type { ControlPanelDaemonNodeRecord, DaemonNodeMonitorRecord } from "../types.js";
import { omit } from "./omit.ts";

function stripControlPanelToken(node: ControlPanelDaemonNodeRecord): DaemonNodeMonitorRecord {
  return omit(node, "nodeToken");
}

function nodeRank(node: DaemonNodeMonitorRecord): number {
  if (node.activeRuns.length > 0) return 4;
  if (node.online && !node.stale && node.status === "ready") return 3;
  if (node.online && !node.stale) return 2;
  if (!node.stale) return 1;
  return 0;
}

function mergedDisplayName(
  winner: DaemonNodeMonitorRecord,
  loser: DaemonNodeMonitorRecord,
): string | undefined {
  const named = [winner, loser].find(
    (node) => "displayName" in node && typeof node.displayName === "string" && node.displayName.trim(),
  );
  return named && "displayName" in named && typeof named.displayName === "string"
    ? named.displayName
    : undefined;
}

export function preferDaemonNode(a: DaemonNodeMonitorRecord, b: DaemonNodeMonitorRecord): DaemonNodeMonitorRecord {
  const rankDelta = nodeRank(b) - nodeRank(a);
  const winner = rankDelta > 0
    ? b
    : rankDelta < 0
      ? a
      : (b.lastSeenAt ?? "").localeCompare(a.lastSeenAt ?? "") > 0 ? b : a;
  const displayName = mergedDisplayName(winner, winner === a ? b : a);
  if (displayName === undefined) return winner;
  const merged: DaemonNodeMonitorRecord & { displayName?: string } = { ...winner, displayName };
  return merged;
}

export function mergeVisibleDaemonNodes(
  authenticatedNodes: DaemonNodeMonitorRecord[],
  controlPanelNodes: ControlPanelDaemonNodeRecord[],
): DaemonNodeMonitorRecord[] {
  const byUser = new Map<string, DaemonNodeMonitorRecord>();
  for (const node of authenticatedNodes) {
    if (!node.userId) continue;
    const existing = byUser.get(node.userId);
    byUser.set(node.userId, existing ? preferDaemonNode(existing, node) : node);
  }
  for (const controlPanelNode of controlPanelNodes) {
    const node = stripControlPanelToken(controlPanelNode);
    if (!node.userId) continue;
    const existing = byUser.get(node.userId);
    byUser.set(node.userId, existing ? preferDaemonNode(existing, node) : node);
  }
  return [...byUser.values()].sort((a, b) => (a.userId ?? "").localeCompare(b.userId ?? ""));
}

/** Preserve each physical computer for runtime selection while coalescing the
 * authenticated and local-control views of the same daemon node. */
export function mergeThreadRuntimeNodes(
  authenticatedNodes: DaemonNodeMonitorRecord[],
  controlPanelNodes: ControlPanelDaemonNodeRecord[],
): DaemonNodeMonitorRecord[] {
  const byId = new Map<string, DaemonNodeMonitorRecord>();
  for (const candidate of [
    ...authenticatedNodes,
    ...controlPanelNodes.map(stripControlPanelToken),
  ]) {
    if (!candidate.userId) continue;
    const existing = byId.get(candidate.id);
    byId.set(candidate.id, existing ? preferDaemonNode(existing, candidate) : candidate);
  }
  return [...byId.values()].sort((a, b) => (
    (a.userId ?? "").localeCompare(b.userId ?? "")
      || a.id.localeCompare(b.id)
  ));
}

/** Remove a deleted computer from an authenticated node snapshot immediately.
 * Managed computers may have several retired runtime incarnations, so their
 * stable managed-node identity is the deletion boundary rather than only the
 * currently displayed runtime id. */
export function withoutDeletedComputer(
  nodes: DaemonNodeMonitorRecord[],
  deleted: { id: string; managedNodeId?: string },
): DaemonNodeMonitorRecord[] {
  return nodes.filter((node) => (
    node.id !== deleted.id
    && (!deleted.managedNodeId || node.managedNodeId !== deleted.managedNodeId)
  ));
}

export function shouldClaimLocalDaemonNode(
  controlPanelNode: ControlPanelDaemonNodeRecord,
  authenticatedNodes: DaemonNodeMonitorRecord[],
): boolean {
  if (!controlPanelNode.userId || !controlPanelNode.nodeToken || !controlPanelNode.online || controlPanelNode.stale) return false;
  return !authenticatedNodes.some((node) =>
    (node.id === controlPanelNode.id || node.userId === controlPanelNode.userId) &&
    node.online &&
    !node.stale
  );
}
