import { useCallback } from "react";
import { useQueries, useQueryClient } from "@tanstack/react-query";
import { listControlPanelUsers } from "../api";
import type { ControlPanelDaemonNodeRecord, UserRecord } from "../types";
import {
  ADMIN_ROSTER_POLL_MS,
  ADMIN_USERS_KEY,
  CONTROL_PANEL_NODES_KEY,
  CONTROL_PANEL_POLL_MS,
  fetchControlPanelNodes,
} from "../lib/controlPanelQueries";

interface AdminNodes {
  nodes: ControlPanelDaemonNodeRecord[];
  users: UserRecord[];
}

// Fallbacks must keep a stable identity: AdminPage keys useKeyChange on
// `nodes`, and a fresh `[]` per render never converges — an infinite
// render loop on every first visit, before the poll resolves.
const NO_NODES: ControlPanelDaemonNodeRecord[] = [];
const NO_USERS: UserRecord[] = [];

type AdminNodeResults = [
  { data?: ControlPanelDaemonNodeRecord[]; error: unknown; dataUpdatedAt: number },
  { data?: UserRecord[]; error: unknown; dataUpdatedAt: number },
];

// Module scope so its identity never changes: useQueries only structurally
// shares a combined result across renders when the combine function itself
// is stable, and without that every observer notification — a poll, another
// screen's fetch — handed this hook a new object and re-rendered its page.
function combineAdminNodes([nodesQuery, usersQuery]: AdminNodeResults) {
  return {
    nodes: nodesQuery.data ?? NO_NODES,
    users: usersQuery.data ?? NO_USERS,
    pollError: nodesQuery.error ?? usersQuery.error,
    dataUpdatedAt: Math.max(nodesQuery.dataUpdatedAt, usersQuery.dataUpdatedAt),
  };
}

// Admin page node snapshot (daemon nodes + users). Node polling shares
// CONTROL_PANEL_NODES_KEY with useLocalDaemonNodes so localhost chat + admin
// reuse one /api/v1/admin/daemon-nodes poll instead of two timers. When `live` is false the
// data is fetched once and not refreshed, which keeps the admin card view stable.
export function useAdminNodes(enabled: boolean, live: boolean = true): {
  nodes: ControlPanelDaemonNodeRecord[];
  users: UserRecord[];
  lastUpdated: Date | null;
  pollError: string | null;
  mergeNodes: (updater: (prev: AdminNodes) => AdminNodes) => void;
  refetch: () => Promise<unknown>;
} {
  const queryClient = useQueryClient();

  const { nodes, users, pollError, dataUpdatedAt } = useQueries({
    queries: [
      {
        queryKey: CONTROL_PANEL_NODES_KEY,
        queryFn: ({ signal }: { signal: AbortSignal }) => fetchControlPanelNodes(signal),
        enabled,
        refetchInterval: live ? CONTROL_PANEL_POLL_MS : false,
      },
      {
        queryKey: ADMIN_USERS_KEY,
        queryFn: async ({ signal }: { signal: AbortSignal }) =>
          (await listControlPanelUsers(signal)).users ?? [],
        enabled,
        refetchInterval: live ? ADMIN_ROSTER_POLL_MS : false,
      },
    ],
    combine: combineAdminNodes,
  });

  const mergeNodes = useCallback(
    (updater: (prev: AdminNodes) => AdminNodes) => {
      queryClient.setQueryData<ControlPanelDaemonNodeRecord[]>(CONTROL_PANEL_NODES_KEY, (prevNodes) => {
        const prevUsers = queryClient.getQueryData<UserRecord[]>(ADMIN_USERS_KEY) ?? [];
        const next = updater({ nodes: prevNodes ?? [], users: prevUsers });
        queryClient.setQueryData(ADMIN_USERS_KEY, next.users);
        return next.nodes;
      });
    },
    [queryClient],
  );

  const refetch = useCallback(
    () => Promise.all([
      queryClient.refetchQueries({ queryKey: CONTROL_PANEL_NODES_KEY }),
      queryClient.refetchQueries({ queryKey: ADMIN_USERS_KEY }),
    ]),
    [queryClient],
  );

  return {
    nodes,
    users,
    lastUpdated: nodes.length > 0 || users.length > 0 ? new Date(dataUpdatedAt) : null,
    pollError: pollError instanceof Error ? pollError.message : pollError ? String(pollError) : null,
    mergeNodes,
    refetch,
  };
}
