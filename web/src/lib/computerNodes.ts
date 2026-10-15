import type { DaemonNodeMonitorRecord } from "../types.js";
import { computerId } from "./createAgent.ts";
import { preferDaemonNode } from "./daemonNodes.ts";

/** Nodes assigned to one user — what a user sees on their own computer page. */
export function nodesAssignedToUser(
  nodes: DaemonNodeMonitorRecord[],
  userId: string | undefined,
): DaemonNodeMonitorRecord[] {
  if (!userId) return [];
  const byComputer = new Map<string, DaemonNodeMonitorRecord>();
  for (const node of nodes) {
    if (node.userId !== userId) continue;
    const identity = computerId(node);
    const current = byComputer.get(identity);
    byComputer.set(identity, current ? preferDaemonNode(current, node) : node);
  }
  return [...byComputer.values()];
}

/** Count only personal user devices against the self-service limit. */
export function countUserDeviceComputers(
  nodes: readonly Pick<DaemonNodeMonitorRecord, "nodeLocation">[],
): number {
  return nodes.filter((node) => node.nodeLocation === "user-device").length;
}

/**
 * Elapsed run time as a compact clock ("48s", "12m", "3h 04m").
 *
 * Deliberately not `formatRelativeTime`: that answers "when did this happen"
 * ("2 minutes ago"), which reads wrong against a run that is still going. This
 * answers "how long has it been going" — it counts up, and stays terse enough
 * to sit at the end of an activity row.
 */
export function formatRunElapsed(startedAt: string, now: number = Date.now()): string {
  const deltaMs = now - new Date(startedAt).getTime();
  if (!Number.isFinite(deltaMs)) return "—";
  const seconds = Math.max(0, Math.floor(deltaMs / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/**
 * Shorten an id while keeping both ends. A CSS ellipsis truncates the tail, and
 * node ids are UUIDs whose *tail* is what differs — `66270440…6043e1a1` tells
 * two machines apart where `66270440-0756-49…` does not.
 */
export function abbreviateNodeId(id: string, edge = 8): string {
  return id.length <= edge * 2 + 1 ? id : `${id.slice(0, edge)}…${id.slice(-edge)}`;
}
