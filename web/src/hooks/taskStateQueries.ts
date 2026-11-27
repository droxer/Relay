import type { QueryClient, QueryFilters } from "@tanstack/react-query";
import type { RelaySession, RelayTaskListItem, TasksResponse } from "../types";
import { HOME_STATS_QUERY_KEY } from "./useHomeStats";
import { SESSIONS_QUERY_KEY, TASKS_QUERY_KEY, THREAD_TASKS_QUERY_KEY } from "./useRelayData";
import { TASK_RECORD_QUERY_KEY } from "./useTaskRecord";
import { WORKSPACE_ACTIVITY_QUERY_KEY } from "./useWorkspaceActivity";

function revalidate(client: QueryClient, filters: QueryFilters) {
  // Invalidation normally replaces an older refetch. A query without data
  // would reuse its initial request, which may have started before this write.
  void client.cancelQueries({ ...filters, predicate: query => query.state.data === undefined });
  void client.invalidateQueries(filters);
}

/** Thread summaries also carry linked Task status and the Home attention count. */
export function invalidateTaskState(client: QueryClient, taskIds: readonly string[] = []) {
  revalidate(client, { queryKey: TASKS_QUERY_KEY });
  revalidate(client, { queryKey: SESSIONS_QUERY_KEY, exact: true });
  revalidate(client, { queryKey: HOME_STATS_QUERY_KEY });
  revalidate(client, { queryKey: WORKSPACE_ACTIVITY_QUERY_KEY });
  for (const id of new Set(taskIds)) {
    revalidate(client, { queryKey: [TASK_RECORD_QUERY_KEY, id], exact: true });
    revalidate(client, { queryKey: ["task-runs", id] });
  }
}

/** A Thread snapshot carries no Task revision. Re-read the server's Task
 * projections when a linked round changes, including its Automation ledger. */
export function invalidateThreadTaskState(
  client: QueryClient,
  session: Pick<RelaySession, "id"> & Partial<Pick<RelaySession, "activeRoundId" | "collaborationRounds" | "taskActivity">>,
  knownTaskId?: string,
) {
  const scope = session.collaborationRounds?.find(round => round.roundId === session.activeRoundId)?.workScope;
  const ids = new Set<string>();
  if (scope?.kind === "task") ids.add(scope.taskId);
  if (knownTaskId) ids.add(knownTaskId);
  if (session.taskActivity?.origin) ids.add(session.taskActivity.origin.taskId);

  const taskLists = client.getQueriesData<TasksResponse | RelayTaskListItem[]>({ queryKey: TASKS_QUERY_KEY });
  const records = client.getQueriesData<RelayTaskListItem>({ queryKey: [TASK_RECORD_QUERY_KEY] });
  const candidates = [...taskLists.flatMap<RelayTaskListItem>(([, value]) => Array.isArray(value) ? value : value?.tasks ?? []),
    ...records.flatMap(([, record]) => record ? [record] : [])];
  for (const task of candidates) {
    if (task.linkedSessionIds?.includes(session.id) || task.awaiting?.sessionId === session.id) {
      ids.add(task.id);
    }
  }
  for (const task of candidates) {
    if (ids.has(task.id) && task.sourceRoutineId) ids.add(task.sourceRoutineId);
  }
  if (ids.size) invalidateTaskState(client, [...ids]);
  else revalidate(client, { queryKey: [...THREAD_TASKS_QUERY_KEY, session.id], exact: true });
}
