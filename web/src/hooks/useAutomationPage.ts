"use client";

import { useQuery, type Query } from "@tanstack/react-query";
import type { PrivateResponseCache } from "../api-client/client";
import { listAutomations, type AutomationsResponse } from "../api-client/tasks";
import { serializeSortParam, type SortState } from "../lib/listSort";
import { RELAY_POLL_INTERVALS_MS } from "../lib/relayPolling";
import type { RoutineFilters, RoutineSortKey } from "../lib/routine";
import { useDebouncedValue } from "./useDebouncedValue";
import { AUTOMATIONS_PAGE_KEY } from "./useRelayData";

const validators = new WeakMap<Query, PrivateResponseCache<AutomationsResponse>>();

export function useAutomationPage({
  projectId, computerId, filters, sort, labels, page, unplacedPage, enabled,
}: {
  projectId?: string;
  computerId?: string;
  filters: RoutineFilters;
  sort: SortState<RoutineSortKey> | null;
  labels: { missingAgent: string; missingTeam: string; workflow: string; unassigned: string };
  page: number;
  unplacedPage: number;
  enabled: boolean;
}) {
  const query = useDebouncedValue(filters.query.trim(), 250);
  const waitingForSearch = query !== filters.query.trim();
  const params = new URLSearchParams();
  if (projectId) params.set("projectId", projectId);
  if (computerId) params.set("computerId", computerId);
  if (query) params.set("q", query);
  if (page > 1) params.set("page", String(page));
  if (sort) params.set("sort", serializeSortParam(sort)!);
  if (filters.assignee.trim()) params.set("assignee", filters.assignee.trim());
  for (const key of ["agent", "tag", "trigger", "state"] as const) {
    if (filters[key] !== "all" && filters[key]) params.set(key, filters[key]);
  }
  if (sort?.key === "assignee") for (const [key, label] of Object.entries(labels)) params.set(key, label);
  const pageParams = params.toString();
  if (computerId && unplacedPage > 1) params.set("unplacedPage", String(unplacedPage));
  const requestParams = params.toString();
  const result = useQuery<AutomationsResponse>({
    queryKey: [...AUTOMATIONS_PAGE_KEY, pageParams, unplacedPage] as const,
    enabled: enabled && !waitingForSearch,
    staleTime: RELAY_POLL_INTERVALS_MS.tasks,
    placeholderData: computerId ? (previous, previousQuery) => previousQuery?.queryKey.at(-2) === pageParams ? previous : undefined : undefined,
    refetchInterval: ({ state }) => state.data?.hasLiveRuns
      || state.data?.tasks.some(task => !task.isRoutine && ["assigned", "queued", "running"].includes(task.status))
      ? RELAY_POLL_INTERVALS_MS.tasks : RELAY_POLL_INTERVALS_MS.idleCollections,
    queryFn: ({ signal, client, queryKey }) => {
      const entry = client.getQueryCache().find({ queryKey, exact: true });
      const cache = (entry && validators.get(entry)) || {};
      if (entry) validators.set(entry, cache);
      return listAutomations(requestParams, signal, cache);
    },
  });
  return { result, waitingForSearch };
}
