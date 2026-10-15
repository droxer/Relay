import { useCallback } from "react";
import { useQueries, useQueryClient } from "@tanstack/react-query";
import { listControlPanelUsers } from "../api";
import type { ControlPanelDaemonNodeRecord, UserRecord } from "../types";
import {
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

  const [nodesQuery, usersQuery] = useQueries({
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
        refetchInterval: live ? CONTROL_PANEL_POLL_MS : false,
      },
    ],
  });

  const nodes = nodesQuery.data ?? NO_NODES;
  const users = usersQuery.data ?? NO_USERS;
  const pollError = nodesQuery.error ?? usersQuery.error;
  const dataUpdatedAt = Math.max(nodesQuery.dataUpdatedAt, usersQuery.dataUpdatedAt);

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
