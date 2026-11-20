"use client";

import { useState } from "react";
import { useQuery, type Query } from "@tanstack/react-query";
import { listControlPanelUsers } from "../api";
import type { PrivateResponseCache } from "../api-client/client";
import type { ControlPanelUsersResponse } from "../types";
import { userSortColumns, type UserQuickFilter } from "../lib/adminHelpers";
import { ADMIN_ROSTER_POLL_MS, ADMIN_USERS_KEY } from "../lib/controlPanelQueries";
import { serializeSortParam } from "../lib/listSort";
import { useDebouncedValue } from "./useDebouncedValue";
import { useListSort } from "./useListSort";
import { usePagination } from "./usePagination";

const SORT_COLUMNS = userSortColumns();
const validators = new WeakMap<Query, PrivateResponseCache<ControlPanelUsersResponse>>();

export function useAdminUsers({ enabled, live }: { enabled: boolean; live: boolean }) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<UserQuickFilter>("all");
  const { page, setPage } = usePagination("userPage");
  const { sort, toggleSort, setSort } = useListSort(SORT_COLUMNS, "userSort");
  const search = useDebouncedValue(query.trim(), 250);
  const waitingForSearch = search !== query.trim();
  const params = new URLSearchParams({ page: String(page) });
  if (search) params.set("q", search);
  if (filter !== "all") params.set("filter", filter);
  const order = serializeSortParam(sort);
  if (order) params.set("sort", order);
  const request = params.toString();

  const result = useQuery({
    queryKey: [...ADMIN_USERS_KEY, request],
    enabled: enabled && !waitingForSearch,
    staleTime: ADMIN_ROSTER_POLL_MS,
    refetchInterval: live ? ADMIN_ROSTER_POLL_MS : false,
    queryFn: ({ client, queryKey, signal }): Promise<ControlPanelUsersResponse> => {
      const entry = client.getQueryCache().find({ queryKey, exact: true });
      const cache = (entry && validators.get(entry)) || {};
      if (entry) validators.set(entry, cache);
      return listControlPanelUsers(signal, request, cache);
    },
  });
  return {
    response: waitingForSearch ? undefined : result.data,
    loading: waitingForSearch || (enabled && result.isPending),
    error: waitingForSearch ? null : result.error, refetch: result.refetch,
    query, setQuery, filter, setFilter, page, setPage, sort, toggleSort, setSort,
    sortColumns: SORT_COLUMNS,
  };
}
