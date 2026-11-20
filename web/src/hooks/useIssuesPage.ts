"use client";

import { useQuery, type Query } from "@tanstack/react-query";
import { listIssues, type IssuesResponse } from "../api-client/tasks";
import type { PrivateResponseCache } from "../api-client/client";
import { isoToday, type BacklogFilters } from "../lib/backlog";
import type { IssueGroupBy, IssueQueue, IssueSortKey } from "../lib/issueQueues";
import { serializeSortParam, type SortState } from "../lib/listSort";
import { serializeLanePages, type LanePages } from "../lib/pagination";
import { RELAY_POLL_INTERVALS_MS } from "../lib/relayPolling";
import { TASK_FLOW_STAGES } from "../lib/taskFlow";
import { useDebouncedValue } from "./useDebouncedValue";
import { ISSUES_PAGE_KEY } from "./useRelayData";

// Each Query belongs to its Account; keep its validator across page remounts.
const validators = new WeakMap<Query, PrivateResponseCache<IssuesResponse>>();

export function useIssuesPage({ filters, view, queue = "open", group = "project", projectId, workspace, sort, page, lanes, labels, enabled }: {
  filters: BacklogFilters;
  view: "list" | "board";
  queue?: IssueQueue;
  group?: IssueGroupBy;
  projectId?: string | null;
  workspace?: { computerId?: string; unplacedPage: number };
  sort: SortState<IssueSortKey> | null;
  page: number;
  lanes: LanePages;
  labels: { missingAgent: string; missingTeam: string; workflow: string; unassigned: string };
  enabled: boolean;
}) {
  const query = useDebouncedValue(filters.query.trim(), 250);
  const waitingForSearch = query !== filters.query.trim();
  const params = new URLSearchParams({ scope: workspace ? "board" : "issues", layout: view, today: isoToday() });
  if (queue !== "open") params.set("queue", queue);
  if (view === "list") {
    if (group !== "project") params.set("group", group);
    if (page > 1) params.set("page", String(page));
    if (workspace && filters.status !== "all") params.set("status", filters.status);
  } else {
    const pages = serializeLanePages(lanes, TASK_FLOW_STAGES);
    if (pages) params.set("lanes", pages);
  }
  if (projectId) params.set("projectId", projectId);
  if (workspace?.computerId) {
    params.set("computerId", workspace.computerId);
    if (workspace.unplacedPage > 1) params.set("unplacedPage", String(workspace.unplacedPage));
  }
  if (sort) params.set("sort", serializeSortParam(sort)!);
  if (query) params.set("q", query);
  if (filters.assignee.trim()) params.set("assignee", filters.assignee.trim());
  for (const key of ["priority", "tag", "agent", "team", "assignment", "due", "source"] as const) {
    if (filters[key] !== "all" && filters[key]) params.set(key, filters[key]);
  }
  if ((view === "list" && group === "assignee") || sort?.key === "assignee") {
    for (const [key, label] of Object.entries(labels)) params.set(key, label);
  }
  const pathParams = params.toString();
  const result = useQuery<IssuesResponse>({
    queryKey: [...ISSUES_PAGE_KEY, pathParams] as const,
    enabled: enabled && !waitingForSearch,
    staleTime: RELAY_POLL_INTERVALS_MS.tasks,
    placeholderData: workspace?.computerId ? (previous, previousQuery) => {
      const previousParams = new URLSearchParams(String(previousQuery?.queryKey.at(-1) ?? ""));
      const currentParams = new URLSearchParams(pathParams);
      previousParams.delete("unplacedPage");
      currentParams.delete("unplacedPage");
      return previousParams.toString() === currentParams.toString() ? previous : undefined;
    } : undefined,
    refetchInterval: ({ state }) => state.data?.tasks?.some(task => ["assigned", "queued", "running"].includes(task.status))
      ? RELAY_POLL_INTERVALS_MS.tasks : RELAY_POLL_INTERVALS_MS.idleCollections,
    queryFn: ({ signal, client, queryKey }): Promise<IssuesResponse> => {
      const entry = client.getQueryCache().find({ queryKey, exact: true });
      const cache = (entry && validators.get(entry)) || {};
      if (entry) validators.set(entry, cache);
      return listIssues(pathParams, signal, cache);
    },
  });
  return { result, waitingForSearch };
}
