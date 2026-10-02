import { listControlPanelDaemonNodes } from "../api";
import type { ControlPanelDaemonNodeRecord } from "../types";

/** Shared TanStack Query key so admin Nodes and thread local-node adoption dedupe polls. */
export const CONTROL_PANEL_NODES_KEY = ["relay", "control-panel-nodes"] as const;
/** The admin employee roster query. */
export const ADMIN_EMPLOYEES_KEY = ["admin", "employees"] as const;
export const CONTROL_PANEL_POLL_MS = 3000;

export async function fetchControlPanelNodes(signal?: AbortSignal): Promise<ControlPanelDaemonNodeRecord[]> {
  return (await listControlPanelDaemonNodes(signal)).nodes ?? [];
}
