import { useCallback } from "react";
import { useQueries, useQueryClient } from "@tanstack/react-query";
import { listControlPanelEmployees } from "../api";
import type { ControlPanelDaemonNodeRecord, EmployeeRecord } from "../types";
import {
  ADMIN_EMPLOYEES_KEY,
  CONTROL_PANEL_NODES_KEY,
  CONTROL_PANEL_POLL_MS,
  fetchControlPanelNodes,
} from "../lib/controlPanelQueries";

interface AdminNodes {
  nodes: ControlPanelDaemonNodeRecord[];
  employees: EmployeeRecord[];
}

// Admin page node snapshot (daemon nodes + employees). Node polling shares
// CONTROL_PANEL_NODES_KEY with useLocalDaemonNodes so localhost chat + admin
// reuse one /api/v1/admin/daemon-nodes poll instead of two timers. When `live` is false the
// data is fetched once and not refreshed, which keeps the admin card view stable.
export function useAdminNodes(enabled: boolean, live: boolean = true): {
  nodes: ControlPanelDaemonNodeRecord[];
  employees: EmployeeRecord[];
  lastUpdated: Date | null;
  pollError: string | null;
  mergeNodes: (updater: (prev: AdminNodes) => AdminNodes) => void;
  refetch: () => Promise<unknown>;
} {
  const queryClient = useQueryClient();

  const [nodesQuery, employeesQuery] = useQueries({
    queries: [
      {
        queryKey: CONTROL_PANEL_NODES_KEY,
        queryFn: ({ signal }: { signal: AbortSignal }) => fetchControlPanelNodes(signal),
        enabled,
        refetchInterval: live ? CONTROL_PANEL_POLL_MS : false,
      },
      {
        queryKey: ADMIN_EMPLOYEES_KEY,
        queryFn: async ({ signal }: { signal: AbortSignal }) =>
          (await listControlPanelEmployees(signal)).employees ?? [],
        enabled,
        refetchInterval: live ? CONTROL_PANEL_POLL_MS : false,
      },
    ],
  });

  const nodes = nodesQuery.data ?? [];
  const employees = employeesQuery.data ?? [];
  const pollError = nodesQuery.error ?? employeesQuery.error;
  const dataUpdatedAt = Math.max(nodesQuery.dataUpdatedAt, employeesQuery.dataUpdatedAt);

  const mergeNodes = useCallback(
    (updater: (prev: AdminNodes) => AdminNodes) => {
      queryClient.setQueryData<ControlPanelDaemonNodeRecord[]>(CONTROL_PANEL_NODES_KEY, (prevNodes) => {
        const prevEmployees = queryClient.getQueryData<EmployeeRecord[]>(ADMIN_EMPLOYEES_KEY) ?? [];
        const next = updater({ nodes: prevNodes ?? [], employees: prevEmployees });
        queryClient.setQueryData(ADMIN_EMPLOYEES_KEY, next.employees);
        return next.nodes;
      });
    },
    [queryClient],
  );

  const refetch = useCallback(
    () => Promise.all([
      queryClient.refetchQueries({ queryKey: CONTROL_PANEL_NODES_KEY }),
      queryClient.refetchQueries({ queryKey: ADMIN_EMPLOYEES_KEY }),
    ]),
    [queryClient],
  );

  return {
    nodes,
    employees,
    lastUpdated: nodes.length > 0 || employees.length > 0 ? new Date(dataUpdatedAt) : null,
    pollError: pollError instanceof Error ? pollError.message : pollError ? String(pollError) : null,
    mergeNodes,
    refetch,
  };
}
