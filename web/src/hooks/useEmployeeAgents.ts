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
  return {
    agents,
    isFetching: query.isFetching,
    error: query.error instanceof Error ? query.error.message : query.error ? String(query.error) : null,
    refetch: query.refetch,
  };
}
