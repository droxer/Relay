import { useQuery } from "@tanstack/react-query";
import type { ControlPanelDaemonNodeRecord } from "../types";
import {
  CONTROL_PANEL_NODES_KEY,
  CONTROL_PANEL_POLL_MS,
  fetchControlPanelNodes,
} from "../lib/controlPanelQueries";

// The directory compares derived node arrays during render. A fresh fallback
// on every render would keep invalidating those arrays before data arrives.
const EMPTY_LOCAL_NODES: ControlPanelDaemonNodeRecord[] = [];

// Admin-only discovery of daemon nodes registered with a co-located control
// panel. Shares CONTROL_PANEL_NODES_KEY with useAdminNodes so threads and the
// Admin pages reuse the same inventory on localhost.
export function useLocalDaemonNodes(enabled: boolean): ControlPanelDaemonNodeRecord[] {
  const query = useQuery({
    queryKey: CONTROL_PANEL_NODES_KEY,
    queryFn: fetchControlPanelNodes,
    enabled,
    staleTime: CONTROL_PANEL_POLL_MS,
    refetchInterval: CONTROL_PANEL_POLL_MS,
  });

  return enabled ? query.data ?? EMPTY_LOCAL_NODES : EMPTY_LOCAL_NODES;
}
