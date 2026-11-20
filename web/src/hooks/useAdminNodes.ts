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
    inventoryLoading: nodesQuery.data === undefined && !nodesQuery.error,
    inventoryError: nodesQuery.error ? String(nodesQuery.error) : null,
    users: usersQuery.data ?? NO_USERS,
    nodesError: nodesQuery.error,
    usersError: usersQuery.error,
    dataUpdatedAt: Math.max(nodesQuery.dataUpdatedAt, usersQuery.dataUpdatedAt),
  };
}

// Admin pages select what to read. The Computer inventory also shares its
// cache with the local workspace and Channels readers.
export function useAdminNodes({ nodesEnabled, usersEnabled, live }: {
  nodesEnabled: boolean;
  usersEnabled: boolean;
  live: boolean;
}): {
  nodes: ControlPanelDaemonNodeRecord[];
  users: UserRecord[];
  inventoryLoading: boolean;
  inventoryError: string | null;
  lastUpdated: Date | null;
  pollError: string | null;
  mergeNodes: (updater: (prev: AdminNodes) => AdminNodes) => void;
  refetch: () => Promise<unknown>;
} {
  const queryClient = useQueryClient();

  const { nodes, users, nodesError, usersError, dataUpdatedAt, inventoryLoading, inventoryError } = useQueries({
    queries: [
      {
        queryKey: CONTROL_PANEL_NODES_KEY,
        staleTime: CONTROL_PANEL_POLL_MS,
        queryFn: ({ signal }: { signal: AbortSignal }) => fetchControlPanelNodes(signal),
        enabled: nodesEnabled,
        refetchInterval: live ? CONTROL_PANEL_POLL_MS : false,
      },
      {
        queryKey: ADMIN_USERS_KEY,
        staleTime: ADMIN_ROSTER_POLL_MS,
        queryFn: async ({ signal }: { signal: AbortSignal }) =>
          (await listControlPanelUsers(signal)).users ?? [],
        enabled: usersEnabled,
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
    () => queryClient.refetchQueries({ queryKey: CONTROL_PANEL_NODES_KEY, exact: true }, { cancelRefetch: false }),
    [queryClient],
  );

  const pollError = (nodesEnabled ? nodesError : null) ?? (usersEnabled ? usersError : null);
  return {
    inventoryLoading,
    inventoryError,
    nodes,
    users,
    lastUpdated: nodes.length > 0 || users.length > 0 ? new Date(dataUpdatedAt) : null,
    pollError: pollError instanceof Error ? pollError.message : pollError ? String(pollError) : null,
    mergeNodes,
    refetch,
  };
}
