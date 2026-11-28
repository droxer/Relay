import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useQueries, useQueryClient, type Query, type QueryStatus, type UseQueryResult } from "@tanstack/react-query";
import { listDaemonNodes, listSessionSummaries, listTasks } from "../api";
import type { DaemonNodeMonitorRecord, ProjectListItem, RelaySession, RelayTaskSummary, SessionSummary, TasksResponse } from "../types";
import { queryCollectionStatus, type ProjectCollectionStatus } from "../lib/projectPage";
import { appendOlderSessionPage, mergeSessionHeadPage, SESSIONS_QUERY_KEY, THREAD_PAGE_SIZE } from "../lib/sessionPollMerge";
import { RELAY_POLL_INTERVALS_MS, sessionsPollIntervalMs } from "../lib/relayPolling";
import { relayApiEndpoint } from "../lib/apiOrigin";
import { shareSessions } from "../lib/sessionEvents";
import { isSessionStreamConnected, subscribeSessionStream } from "../lib/sessionStreamStatus";
import { useKeyChange } from "./useKeyChange";
import type { TaskListCache } from "../api-client/tasks";
import type { SessionHeadCache } from "../api-client/sessions";
import { projectDirectoryOptions, PROJECTS_QUERY_KEY } from "./projectQueries";

export const RELAY_QUERY_KEY = ["relay"] as const;
const RELAY_KEY = RELAY_QUERY_KEY;
export const NODES_QUERY_KEY = ["relay", "daemon-nodes"] as const;
const NODES_KEY = NODES_QUERY_KEY;
const SESSIONS_KEY = SESSIONS_QUERY_KEY;
export { SESSIONS_QUERY_KEY };
const SESSION_PAGES_KEY = ["relay", "session-pages"] as const;
type SessionPages = { headCursor: string | null; olderCursor?: string | null; homeTaskNeedsYou?: number | null };
// A poll hands its page to structuralSharing, where the merge reads the
// cache at the moment of commit. Other writes already supply merged rows.
const sessionHeadPages = new WeakMap<RelaySession[], {
  summaries: SessionSummary[];
  hasOlder: boolean;
  atRequestStart: RelaySession[];
}>();
const TASKS_KEY = ["relay", "tasks"] as const;
export { PROJECTS_QUERY_KEY };
export const TASKS_QUERY_KEY = TASKS_KEY;
export const HOME_TASKS_QUERY_KEY = [...TASKS_KEY, "home"] as const;
export const ISSUES_PAGE_KEY = [...TASKS_KEY, "issue-page"] as const;
export const AUTOMATIONS_PAGE_KEY = [...TASKS_KEY, "automation-page"] as const;
export const THREAD_TASKS_QUERY_KEY = [...TASKS_KEY, "thread"] as const;
export const COMPUTER_TASKS_QUERY_KEY = [...TASKS_KEY, "computer"] as const;
type RelayDataResult = {
  nodes: DaemonNodeMonitorRecord[];
  nodesReady: boolean;
  nodesStatus: QueryStatus;
  refetchNodes: () => Promise<unknown>;
  sessions: RelaySession[];
  /** The first thread list is still on its way: an empty `sessions` means
   *  "not yet", not "none". */
  sessionsLoading: boolean;
  /** Older threads exist beyond the loaded pages. */
  hasMoreSessions: boolean;
  /** An older page is on its way. */
  loadingMoreSessions: boolean;
  /** The last older-page request failed; calling `loadMoreSessions` retries. */
  moreSessionsFailed: boolean;
  /** Load the next older page of the thread list. */
  loadMoreSessions: () => Promise<void>;
  refreshSessions: () => Promise<void>;
  tasks: RelayTaskSummary[];
  homeTaskNeedsYou?: number;
  homeTaskProjects?: TasksResponse["homeProjects"];
  homeUntriaged?: TasksResponse["homeUntriaged"];
  homeWaitingToStart?: number;
  threadTaskContext?: TasksResponse["threadTaskContext"];
  projectDashboard?: TasksResponse["projectDashboard"];
  projects: ProjectListItem[];
  homeStatus: ProjectCollectionStatus;
  projectsStatus: ProjectCollectionStatus;
  tasksStatus: ProjectCollectionStatus;
  projectsError: string;
  isRefreshing: boolean;
  refresh: () => Promise<void>;
  upsertNode: (node: DaemonNodeMonitorRecord) => void;
};

type RelayCollections = Pick<
  RelayDataResult,
  "nodes" | "nodesReady" | "nodesStatus" | "refetchNodes" | "sessions" | "sessionsLoading" | "tasks" | "homeTaskProjects" | "homeUntriaged" | "homeWaitingToStart" | "threadTaskContext" | "projectDashboard" | "projects" | "projectsStatus" | "tasksStatus" | "projectsError" | "homeStatus"
>;

/* The only fields the app reads off the collection polls, folded into one value.

   Without `combine`, useQueries hands back the raw result array and notifies on
   every change to any tracked field of any query — and reading fetchStatus for
   the projects status tracks it on all observers. So each poll's fetch
   start and its fetch end each re-rendered the whole App, ~18 commits per 10s
   on data that had not changed, and every thread row re-rendered with it.
   React Query deep-compares a combined value against the last one
   (replaceEqualDeep), so an identical poll now yields the identical object and
   no render. Module scope keeps the function's identity stable, which is what
   lets the observer reuse the last result instead of recombining. */
function combineRelayCollections(results: UseQueryResult<unknown>[]): RelayCollections {
  const [nodesQuery, sessionsQuery, tasksQuery, projectsQuery] = results;
  const taskData = tasksQuery.data as RelayTaskSummary[] | TasksResponse | undefined;
  return {
    nodesReady: nodesQuery.isSuccess,
    nodes: (nodesQuery.data as DaemonNodeMonitorRecord[] | undefined) ?? [],
    nodesStatus: nodesQuery.status,
    refetchNodes: nodesQuery.refetch,
    sessions: (sessionsQuery.data as RelaySession[] | undefined) ?? [],
    sessionsLoading: sessionsQuery.isLoading,
    tasks: (Array.isArray(taskData) ? taskData : taskData?.tasks) ?? [],
    homeTaskProjects: Array.isArray(taskData) ? undefined : taskData?.homeProjects,
    homeUntriaged: Array.isArray(taskData) ? undefined : taskData?.homeUntriaged,
    homeWaitingToStart: Array.isArray(taskData) ? undefined : taskData?.homeWaitingToStart,
    threadTaskContext: Array.isArray(taskData) ? undefined : taskData?.threadTaskContext,
    projectDashboard: Array.isArray(taskData) ? undefined : taskData?.projectDashboard,
    projects: (projectsQuery.data as ProjectListItem[] | undefined) ?? [],
    homeStatus: [nodesQuery, sessionsQuery, tasksQuery, projectsQuery].some(q => q.isError)
      ? "error" : [nodesQuery, sessionsQuery, tasksQuery, projectsQuery].some(q => !q.isSuccess) ? "loading" : "ready",
    projectsStatus: queryCollectionStatus(projectsQuery),
    tasksStatus: queryCollectionStatus(tasksQuery),
    projectsError: projectsQuery.error instanceof Error
      ? projectsQuery.error.message
      : projectsQuery.error
        ? String(projectsQuery.error)
        : "",
  };
}

// Server state for the control-plane console, owned by TanStack Query.
// Visible nodes and task state poll every 10s; sessions back off
// while the open thread's SSE tail is connected; projects reconcile less often.
// No poll runs in a hidden tab. Dedup and retry/backoff come
// from the cache instead of hand-rolled timers. The hook keeps its previous
// external shape so callers (App.tsx) are unchanged.
export function useRelayData(
  token: string | undefined,
  enabled: boolean,
  taskListVisible = true,
  workspaceVisible = true,
  projectedTasksOnly = false,
  taskProjectId?: string,
  taskScope?: TaskListCache["scope"],
  { pageOwned = false, threadId: taskThreadId, computerId: taskComputerId, projectDirectory = true }: {
    pageOwned?: boolean; threadId?: string; computerId?: string;
    projectDirectory?: boolean;
  } = {},
): RelayDataResult {
  const queryClient = useQueryClient();
  const homeTaskView = taskScope === "home";
  const tasksKey = useMemo(() => {
    if (taskThreadId) return [...THREAD_TASKS_QUERY_KEY, taskThreadId];
    const prefix = taskComputerId ? [...COMPUTER_TASKS_QUERY_KEY, taskComputerId]
      : taskProjectId ? [...TASKS_KEY, taskProjectId] : TASKS_KEY;
    return taskScope ? [...prefix, taskScope] : prefix;
  }, [taskProjectId, taskScope, taskThreadId, taskComputerId]);
  // Keep each validator with its owning query, including across route switches.
  const taskListCaches = useRef(new WeakMap<Query, TaskListCache>());
  const sessionHeadCache = useRef<SessionHeadCache>({});
  // Background reconciliation must stay visually silent. Only a user/app
  // initiated refresh drives page-level refresh chrome.
  const [manualRefreshPending, setManualRefreshPending] = useState(false);

  const manualRefreshesRef = useRef(0);
  // Re-renders only when the stream connects or drops, which re-arms the
  // sessions interval at once instead of after the next poll.
  const streamConnected = useSyncExternalStore(subscribeSessionStream, isSessionStreamConnected, () => false);
  const computersHaveRuns = () => queryClient.getQueryData<DaemonNodeMonitorRecord[]>(NODES_KEY)?.some(node => node.activeRuns?.length) ?? false;

  // Thread list paging. The head cursor is where the polled first page ends;
  // the older cursor is where the last older page ended — undefined until one
  // loads, null once the oldest has. Both are keyset positions, so a poll that
  // reshuffles the first page never invalidates them.
  const [headCursor, setHeadCursor] = useState<string | null>(() => queryClient.getQueryData<SessionPages>(SESSION_PAGES_KEY)?.headCursor ?? null);
  const [olderCursor, setOlderCursor] = useState<string | null | undefined>(() => queryClient.getQueryData<SessionPages>(SESSION_PAGES_KEY)?.olderCursor);
  const [homeTaskNeedsYou, setHomeTaskNeedsYou] = useState<number | null | undefined>(
    () => queryClient.getQueryData<SessionPages>(SESSION_PAGES_KEY)?.homeTaskNeedsYou,
  );
  // A missing field in a successful response identifies a pre-projection
  // backend. Surfaces with no Task table use the activity included in the
  // existing Thread reconciliation for the shell's counts and statuses.
  const fetchFullTasks = !pageOwned && (!projectedTasksOnly || homeTaskNeedsYou === null);
  const [loadingMoreSessions, setLoadingMoreSessions] = useState(false);
  const [moreSessionsFailed, setMoreSessionsFailed] = useState(false);
  const loadingMoreRef = useRef(false);
  const nextSessionCursor = olderCursor === undefined ? headCursor : olderCursor;

  const { nodes, nodesReady, nodesStatus, refetchNodes, sessions, sessionsLoading, tasks, homeTaskProjects, homeUntriaged, homeWaitingToStart, threadTaskContext,
    projectDashboard, projects, projectsStatus, tasksStatus, projectsError, homeStatus } = useQueries({
    combine: combineRelayCollections,
    queries: [
      {
        queryKey: NODES_KEY,
        staleTime: RELAY_POLL_INTERVALS_MS.nodes,
        enabled,
        refetchInterval: workspaceVisible ? RELAY_POLL_INTERVALS_MS.nodes : 60_000,
        // Nodes are readable with the session cookie alone — the backend
        // scopes /daemon-nodes to what the actor owns. Skipping the fetch
        // without a sandbox token left every tokenless client blind to live
        // runs: no working badge, and a cancel button with no node to talk to.
        queryFn: async ({ signal }: { signal: AbortSignal }): Promise<DaemonNodeMonitorRecord[]> =>
          (await listDaemonNodes(token, signal)).nodes ?? [],
      },
      {
        queryKey: SESSIONS_KEY,
        staleTime: RELAY_POLL_INTERVALS_MS.sessions,
        enabled,
        refetchInterval: () => {
          if (!workspaceVisible) return 60_000;
          const rows = queryClient.getQueryData<RelaySession[]>(SESSIONS_KEY);
          const active = rows?.some(session => session.execution
            ? !["terminal", "recovery_required"].includes(session.execution.phase)
            : session.status === "running");
          return sessionsPollIntervalMs(streamConnected, Boolean(active) || computersHaveRuns());
        },
        // Keep an unchanged session's identity across polls without walking
        // its events, so an identical poll re-renders no row.
        structuralSharing: (previous: unknown, next: unknown) => {
          const current = previous as RelaySession[] | undefined;
          const rows = next as RelaySession[];
          const head = sessionHeadPages.get(rows);
          return shareSessions(current, head
            ? mergeSessionHeadPage(current ?? [], head.summaries, head.hasOlder, head.atRequestStart)
            : rows);
        },
        // The poll reads only the first page; older pages load on demand and
        // stay in the cache below it (mergeSessionHeadPage).
        queryFn: async ({ signal }: { signal: AbortSignal }): Promise<RelaySession[]> => {
          const atRequestStart = queryClient.getQueryData<RelaySession[]>(SESSIONS_KEY) ?? [];
          const page = await listSessionSummaries(signal, { limit: THREAD_PAGE_SIZE, includeActivity: true }, sessionHeadCache.current);
          setHomeTaskNeedsYou(typeof page.homeTaskNeedsYou === "number" ? page.homeTaskNeedsYou : null);
          const next = typeof page.nextCursor === "string" ? page.nextCursor : null;
          setHeadCursor(next);
          // The first page is the whole list: nothing older is left to load.
          if (next === null) setOlderCursor(undefined);
          const result: RelaySession[] = [];
          sessionHeadPages.set(result, { summaries: page.sessions ?? [], hasOlder: next !== null, atRequestStart });
          return result;
        },
      },
      {
        queryKey: tasksKey,
        staleTime: RELAY_POLL_INTERVALS_MS.tasks,
        enabled: enabled && fetchFullTasks,
        refetchInterval: () => {
          if (!taskListVisible) return 60_000;
          const data = queryClient.getQueryData<RelayTaskSummary[] | TasksResponse>(tasksKey);
          const rows = Array.isArray(data) ? data : data?.tasks;
          const active = !Array.isArray(data) && (data?.projectDashboard?.hasQueuedOrRunning || (data?.homeWaitingToStart ?? 0) > 0)
            || rows?.some(task => ["assigned", "queued", "running"].includes(task.status));
          return active || computersHaveRuns() ? RELAY_POLL_INTERVALS_MS.tasks : RELAY_POLL_INTERVALS_MS.idleCollections;
        },
        queryFn: async ({ signal }: { signal: AbortSignal }): Promise<RelayTaskSummary[] | TasksResponse> => {
          const query = queryClient.getQueryCache().find({ queryKey: tasksKey, exact: true });
          const cached = query && taskListCaches.current.get(query);
          const cache = cached ?? (taskThreadId ? { threadId: taskThreadId }
            : taskComputerId ? { computerId: taskComputerId, scope: taskScope }
            : { projectId: taskProjectId, scope: taskScope });
          if (query && !cached) taskListCaches.current.set(query, cache);
          const result = await listTasks(signal, cache);
          if (result.flowPolicy) queryClient.setQueryData(["task-flow-policy"], result.flowPolicy);
          if (result.flowUsage) queryClient.setQueryData(["task-flow-usage"], result.flowUsage);
          return homeTaskView || taskThreadId || result.projectDashboard ? result : result.tasks ?? [];
        },
      },
      {
        ...projectDirectoryOptions(),
        enabled: enabled && projectDirectory,
        refetchInterval: RELAY_POLL_INTERVALS_MS.projects,
      },
    ],
  });

  const previouslyVisible = useRef(taskListVisible);
  useEffect(() => {
    const wasVisible = previouslyVisible.current;
    previouslyVisible.current = taskListVisible;
    if (enabled && taskListVisible && !wasVisible) {
      void queryClient.refetchQueries({ queryKey: tasksKey, exact: true, stale: true }, { cancelRefetch: false });
    }
  }, [enabled, taskListVisible, queryClient, tasksKey]);

  useEffect(() => {
    if (!enabled || !workspaceVisible || typeof EventSource === "undefined") return;
    const source = new EventSource(relayApiEndpoint("/threads/activity/changes"), { withCredentials: true });
    const projections = [SESSIONS_KEY, HOME_TASKS_QUERY_KEY];
    const refresh = () => {
      // An initial request without cached data would otherwise be reused
      // even when it began before the Task change committed.
      for (const queryKey of projections) {
        const filters = { queryKey, exact: true };
        void queryClient.cancelQueries({ ...filters, predicate: query => query.state.data === undefined });
        void queryClient.invalidateQueries(filters);
      }
    };
    let needsCatchUp = projections.some(queryKey => queryClient.getQueryData(queryKey) !== undefined);
    source.addEventListener("open", () => {
      if (needsCatchUp) refresh();
      needsCatchUp = true;
    });
    source.addEventListener("changed", refresh);
    return () => source.close();
  }, [enabled, workspaceVisible, queryClient]);

  const previouslyWorkspaceVisible = useRef(workspaceVisible);
  useEffect(() => {
    const wasVisible = previouslyWorkspaceVisible.current;
    previouslyWorkspaceVisible.current = workspaceVisible;
    if (enabled && workspaceVisible && !wasVisible) {
      for (const queryKey of [SESSIONS_KEY, NODES_KEY]) {
        void queryClient.refetchQueries({ queryKey, exact: true, stale: true }, { cancelRefetch: false });
      }
    }
  }, [enabled, workspaceVisible, queryClient]);

  // Cursors describe the cached rows, so keep their lifetime with those rows.
  useEffect(() => {
    if (enabled) queryClient.setQueryData<SessionPages>(SESSION_PAGES_KEY, { headCursor, olderCursor, homeTaskNeedsYou });
  }, [enabled, headCursor, olderCursor, homeTaskNeedsYou, queryClient]);

  // When disabled (e.g. logged out) drop cached rows so the UI clears at once.
  // resetQueries, NOT setQueryData: seeding [] counts as data written after
  // mount, so React Query then reports isPending false and isFetchedAfterMount
  // true for a request still in flight — which made every collection read
  // "ready" mid-fetch and turned the loading states built on it into dead code.
  // Resetting returns each query to a genuinely unfetched state; the `?? []`
  // fallbacks below still clear the UI to empty exactly as before, and nothing
  // refetches because this only runs while the queries are disabled.
  useEffect(() => {
    if (!enabled) {
      taskListCaches.current = new WeakMap();
      sessionHeadCache.current = {};
      void queryClient.resetQueries({ queryKey: RELAY_KEY });
    }
  }, [enabled, queryClient]);
  // The thread pages go with the cache they described.
  useKeyChange(enabled, (isEnabled) => {
    if (isEnabled) return;
    setHeadCursor(null);
    setOlderCursor(undefined);
    setHomeTaskNeedsYou(undefined);
    setMoreSessionsFailed(false);
  });

  const loadMoreSessions = useCallback(async () => {
    if (!enabled || !nextSessionCursor || loadingMoreRef.current) return;
    if (!queryClient.getQueryData<RelaySession[]>(SESSIONS_KEY)) return;
    loadingMoreRef.current = true;
    setLoadingMoreSessions(true);
    try {
      const page = await listSessionSummaries(undefined, { limit: THREAD_PAGE_SIZE, cursor: nextSessionCursor, includeActivity: true });
      queryClient.setQueryData<RelaySession[]>(SESSIONS_KEY, (current) =>
        current ? appendOlderSessionPage(current, page.sessions ?? []) : current);
      setOlderCursor(typeof page.nextCursor === "string" ? page.nextCursor : null);
      setMoreSessionsFailed(false);
    } catch {
      // Keep the cursor: the rail offers the same page again.
      setMoreSessionsFailed(true);
    } finally {
      loadingMoreRef.current = false;
      setLoadingMoreSessions(false);
    }
  }, [enabled, nextSessionCursor, queryClient]);

  // Refetch under the new credential whenever the active token changes.
  const previousTokenRef = useRef(token);
  useEffect(() => {
    const previous = previousTokenRef.current;
    previousTokenRef.current = token;
    if (enabled && previous !== token) {
      void queryClient.refetchQueries({ queryKey: NODES_KEY, exact: true, type: "active" });
    }
  }, [token, enabled, queryClient]);

  const refreshSessions = useCallback(() => queryClient.refetchQueries(
    { queryKey: SESSIONS_KEY, exact: true, type: "active" },
    { cancelRefetch: false, throwOnError: true },
  ), [queryClient]);

  const refresh = useCallback(
    async () => {
      if (!enabled) return;
      manualRefreshesRef.current += 1;
      setManualRefreshPending(true);
      try {
        await queryClient.refetchQueries({ queryKey: RELAY_KEY, type: "active" });
      } finally {
        manualRefreshesRef.current -= 1;
        if (manualRefreshesRef.current === 0) setManualRefreshPending(false);
      }
    },
    [enabled, queryClient],
  );

  const upsertNode = useCallback(
    (node: DaemonNodeMonitorRecord) => {
      queryClient.setQueryData<DaemonNodeMonitorRecord[]>(NODES_KEY, (current) => {
        const nodes = current ?? [];
        return nodes.some((candidate) => candidate.id === node.id)
          ? nodes.map((candidate) => (candidate.id === node.id ? node : candidate))
          : [...nodes, node];
      });
    },
    [queryClient],
  );

  return {
    nodes,
    nodesReady,
    nodesStatus,
    refetchNodes,
    sessions,
    sessionsLoading,
    hasMoreSessions: Boolean(nextSessionCursor),
    loadingMoreSessions,
    moreSessionsFailed,
    loadMoreSessions,
    refreshSessions,
    tasks,
    homeTaskNeedsYou: projectedTasksOnly || taskProjectId || taskThreadId || taskComputerId || taskScope === "automations" || homeTaskView
      ? homeTaskNeedsYou ?? undefined : undefined,
    homeTaskProjects,
    homeUntriaged,
    homeWaitingToStart,
    threadTaskContext,
    projectDashboard,
    projects,
    projectsStatus,
    tasksStatus,
    projectsError,
    homeStatus,
    isRefreshing: manualRefreshPending,
    refresh,
    upsertNode,
  };
}
