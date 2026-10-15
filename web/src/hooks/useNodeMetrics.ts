import { useMemo } from "react";
import { isStale, visualStatus } from "../lib/adminHelpers";
import type { ControlPanelDaemonNodeRecord, UserRecord } from "../types";

export interface NodeMetrics {
  total: number;
  ready: number;
  running: number;
  failed: number;
  queued: number;
  userTotal: number;
}

export function useNodeMetrics(
  nodes: ControlPanelDaemonNodeRecord[],
  users: UserRecord[],
): NodeMetrics {
  return useMemo(() => {
    const total = nodes.length;
    const ready = nodes.filter((node) => visualStatus(node) === "ready").length;
    const running = nodes.filter((node) => !isStale(node) && node.status === "running").length;
    const failed = nodes.filter((node) => {
      const status = visualStatus(node);
      return status === "failed" || status === "stale";
    }).length;
    const queued = nodes.reduce((acc, node) => acc + node.queuedCommandCount, 0);
    const userTotal =
      users.length || new Set(nodes.map((node) => node.userId).filter(Boolean)).size;
    return { total, ready, running, failed, queued, userTotal };
  }, [nodes, users]);
}
