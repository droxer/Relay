import { listControlPanelDaemonNodes } from "../api";
import type { QueryClient, QueryFunctionContext } from "@tanstack/react-query";
import type { PrivateResponseCache } from "../api-client/client";
import type { ControlPanelDaemonNodeRecord, ControlPanelDaemonNodesResponse } from "../types";

/** Shared TanStack Query key for fleet health and the local thread runtime picker. */
export const CONTROL_PANEL_NODES_KEY = ["relay", "control-panel-nodes"] as const;
/** The admin user roster query. */
export const ADMIN_USERS_KEY = ["admin", "users"] as const;
/** Node status: heartbeats move it in the background, but an admin's own
    actions refetch it at once, so this poll only catches other machines. */
export const CONTROL_PANEL_POLL_MS = 10_000;
/** The user roster and a settled waitlist change only through admin edits,
    which write or invalidate their caches, so the poll only catches other admins. */
export const ADMIN_ROSTER_POLL_MS = 30_000;

const fleetCaches = new WeakMap<QueryClient, PrivateResponseCache<ControlPanelDaemonNodesResponse>>();

export async function fetchControlPanelNodes({ client, signal }: QueryFunctionContext): Promise<ControlPanelDaemonNodeRecord[]> {
  let responseCache = fleetCaches.get(client);
  if (!responseCache) {
    responseCache = {};
    fleetCaches.set(client, responseCache);
  }
  return (await listControlPanelDaemonNodes(signal, responseCache)).nodes ?? [];
}
