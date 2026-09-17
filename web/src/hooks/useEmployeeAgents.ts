"use client";

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { listEmployeeAgents } from "../api";
import { dedupeAgentsById } from "../lib/employeeAgents";
import type { EmployeeAgent } from "../types";

export const EMPLOYEE_AGENTS_QUERY_KEY = "employee-agents";

export function useEmployeeAgents(employeeId?: string): {
  agents: EmployeeAgent[];
  isFetching: boolean;
  error: string | null;
  refetch: () => Promise<unknown>;
} {
  const query = useQuery({
    queryKey: [EMPLOYEE_AGENTS_QUERY_KEY, employeeId],
    queryFn: ({ signal }) => listEmployeeAgents(signal),
    enabled: Boolean(employeeId),
    refetchInterval: 10_000,
  });
  const agents = useMemo(() => dedupeAgentsById(query.data?.agents ?? []), [query.data]);
  // Getters, not values: React Query re-renders a component for every result
  // field the component READ. Reading isFetching here on behalf of callers
  // that only want the list (App, every board) re-rendered the whole app on
  // each 10s poll's start and end. Only a caller that reads it now pays.
  return {
    agents,
    get isFetching() { return query.isFetching; },
    get error() { return query.error instanceof Error ? query.error.message : query.error ? String(query.error) : null; },
    refetch: query.refetch,
  };
}
