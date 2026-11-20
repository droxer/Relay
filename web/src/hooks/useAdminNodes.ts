import { useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ControlPanelDaemonNodeRecord } from "../types";
import {
  ADMIN_USERS_KEY,
  CONTROL_PANEL_NODES_KEY,
  CONTROL_PANEL_POLL_MS,
  fetchControlPanelNodes,
} from "../lib/controlPanelQueries";

// AdminPage watches the inventory's identity to advance its credentials cache.
const NO_NODES: ControlPanelDaemonNodeRecord[] = [];

export function useAdminNodes({ enabled, live }: { enabled: boolean; live: boolean }) {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: CONTROL_PANEL_NODES_KEY,
    staleTime: CONTROL_PANEL_POLL_MS,
    queryFn: fetchControlPanelNodes,
    enabled,
    refetchInterval: live ? CONTROL_PANEL_POLL_MS : false,
  });
  const mergeNodes = useCallback((update: (nodes: ControlPanelDaemonNodeRecord[]) => ControlPanelDaemonNodeRecord[]) => {
    client.setQueryData<ControlPanelDaemonNodeRecord[]>(CONTROL_PANEL_NODES_KEY, previous => previous && update(previous));
    void client.invalidateQueries({ queryKey: ADMIN_USERS_KEY, refetchType: "none" });
  }, [client]);
  const refetch = useCallback(
    () => client.refetchQueries({ queryKey: CONTROL_PANEL_NODES_KEY, exact: true }, { cancelRefetch: false }),
    [client],
  );
  return {
    nodes: query.data ?? NO_NODES,
    inventoryLoading: enabled && query.isPending,
    inventoryError: enabled && query.error ? query.error.message : null,
    mergeNodes,
    refetch,
  };
}
