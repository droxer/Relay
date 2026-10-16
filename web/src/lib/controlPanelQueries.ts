import { listControlPanelDaemonNodes } from "../api";
import type { ControlPanelDaemonNodeRecord } from "../types";

/** Shared TanStack Query key so admin Nodes and thread local-node adoption dedupe polls. */
export const CONTROL_PANEL_NODES_KEY = ["relay", "control-panel-nodes"] as const;
/** The admin user roster query. */
export const ADMIN_USERS_KEY = ["admin", "users"] as const;
/** Node status: heartbeats move it in the background, but an admin's own
    actions refetch it at once, so this poll only catches other machines. */
export const CONTROL_PANEL_POLL_MS = 10_000;
/** The user roster and a settled waitlist change only through admin edits,
    which write or invalidate their caches, so the poll only catches other admins. */
export const ADMIN_ROSTER_POLL_MS = 30_000;

export async function fetchControlPanelNodes(signal?: AbortSignal): Promise<ControlPanelDaemonNodeRecord[]> {
  return (await listControlPanelDaemonNodes(signal)).nodes ?? [];
}
