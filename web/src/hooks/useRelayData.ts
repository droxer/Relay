import { useCallback, useEffect, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { useQueries, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { listDaemonNodes, listProjects, listSandboxes, listSessionSummaries, listTasks } from "../api";
import type { DaemonNodeMonitorRecord, ProjectRecord, RelaySession, RelayTaskSummary, SandboxRecord } from "../types";
import { queryCollectionStatus, type ProjectCollectionStatus } from "../lib/projectPage";
import { mergeSessionSummaries } from "../lib/sessionPollMerge";
import { RELAY_POLL_INTERVALS_MS } from "../lib/relayPolling";

export const RELAY_QUERY_KEY = ["relay"] as const;
const RELAY_KEY = RELAY_QUERY_KEY;
const SANDBOXES_KEY = ["relay", "sandboxes"] as const;
export const NODES_QUERY_KEY = ["relay", "daemon-nodes"] as const;
const NODES_KEY = NODES_QUERY_KEY;
const SESSIONS_KEY = ["relay", "sessions"] as const;
export const SESSIONS_QUERY_KEY = SESSIONS_KEY;
const TASKS_KEY = ["relay", "tasks"] as const;
export const PROJECTS_QUERY_KEY = ["relay", "projects"] as const;
const PROJECTS_KEY = PROJECTS_QUERY_KEY;
export const TASKS_QUERY_KEY = TASKS_KEY;
type RelayDataResult = {
  sandboxes: SandboxRecord[];
  nodes: DaemonNodeMonitorRecord[];
  sessions: RelaySession[];
  tasks: RelayTaskSummary[];
  projects: ProjectRecord[];
  projectsStatus: ProjectCollectionStatus;
  projectsError: string;
  isRefreshing: boolean;
  refresh: (signal?: AbortSignal, tokenOverride?: string) => Promise<void>;
  setSandboxes: Dispatch<SetStateAction<SandboxRecord[]>>;
  upsertNode: (node: DaemonNodeMonitorRecord) => void;
};

type RelayCollections = Pick<
  RelayDataResult,
  "sandboxes" | "nodes" | "sessions" | "tasks" | "projects" | "projectsStatus" | "projectsError"
>;

/* The only fields the app reads off the five polls, folded into one value.

   Without `combine`, useQueries hands back the raw result array and notifies on
   every change to any tracked field of any query — and reading fetchStatus for
   the projects status tracks it on all five observers. So each poll's fetch
   start and its fetch end each re-rendered the whole App, ~18 commits per 10s
   on data that had not changed, and every thread row re-rendered with it.
   React Query deep-compares a combined value against the last one
   (replaceEqualDeep), so an identical poll now yields the identical object and
   no render. Module scope keeps the function's identity stable, which is what
   lets the observer reuse the last result instead of recombining. */
function combineRelayCollections(results: UseQueryResult<unknown>[]): RelayCollections {
  const [sandboxesQuery, nodesQuery, sessionsQuery, tasksQuery, projectsQuery] = results;
  return {
    sandboxes: (sandboxesQuery.data as SandboxRecord[] | undefined) ?? [],
    nodes: (nodesQuery.data as DaemonNodeMonitorRecord[] | undefined) ?? [],
    sessions: (sessionsQuery.data as RelaySession[] | undefined) ?? [],
    tasks: (tasksQuery.data as RelayTaskSummary[] | undefined) ?? [],
    projects: (projectsQuery.data as ProjectRecord[] | undefined) ?? [],
    projectsStatus: queryCollectionStatus(projectsQuery),
    projectsError: projectsQuery.error instanceof Error
      ? projectsQuery.error.message
      : projectsQuery.error
        ? String(projectsQuery.error)
        : "",
  };
}

// Server state for the control-plane console, owned by TanStack Query. The
// Freshness-critical nodes, sessions, and task state poll every 3s; stable
// sandbox inventory reconciles less often. Dedup and retry/backoff come
// from the cache instead of hand-rolled timers. The hook keeps its previous
// external shape so callers (App.tsx) are unchanged.
export function useRelayData(
  token: string | undefined,
  enabled: boolean,
): RelayDataResult {
  const queryClient = useQueryClient();
  // Background reconciliation must stay visually silent. Only a user/app
  // initiated refresh drives page-level refresh chrome.
  const [manualRefreshPending, setManualRefreshPending] = useState(false);

  // The token used by the next fetch. Held in a ref (not the query key) to
  // preserve the previous single-bucket behavior: the lists are one cache
  // entry refetched with whatever token is current, regardless of which token
  // produced the rows already on screen.
  const tokenRef = useRef(token);
  tokenRef.current = token;
  // One-shot override applied by refresh(_, tokenOverride) during sandbox
  // provisioning, before the freshly minted token has propagated into state.
  const overrideRef = useRef<string | undefined>(undefined);
  const fetchToken = () => overrideRef.current ?? tokenRef.current;

  const { sandboxes, nodes, sessions, tasks, projects, projectsStatus, projectsError } = useQueries({
    combine: combineRelayCollections,
    queries: [
      {
        queryKey: SANDBOXES_KEY,
        enabled,
        refetchInterval: RELAY_POLL_INTERVALS_MS.sandboxes,
        queryFn: async ({ signal }: { signal: AbortSignal }): Promise<SandboxRecord[]> => {
          const tk = fetchToken();
          return tk ? ((await listSandboxes(tk, signal)).sandboxes ?? []) : [];
        },
      },
      {
        queryKey: NODES_KEY,
        enabled,
        refetchInterval: RELAY_POLL_INTERVALS_MS.nodes,
        // Nodes are readable with the session cookie alone — the backend
        // scopes /daemon-nodes to what the actor owns. Skipping the fetch
        // without a sandbox token left every tokenless client blind to live
        // runs: no working badge, and a cancel button with no node to talk to.
        queryFn: async ({ signal }: { signal: AbortSignal }): Promise<DaemonNodeMonitorRecord[]> =>
          (await listDaemonNodes(fetchToken(), signal)).nodes ?? [],
      },
      {
        queryKey: SESSIONS_KEY,
        enabled,
        refetchInterval: RELAY_POLL_INTERVALS_MS.sessions,
        queryFn: async ({ signal }: { signal: AbortSignal }): Promise<RelaySession[]> => {
          const summaries = (await listSessionSummaries(signal)).sessions ?? [];
          return mergeSessionSummaries(
            queryClient.getQueryData<RelaySession[]>(SESSIONS_KEY) ?? [],
            summaries,
          );
        },
      },
      {
        queryKey: TASKS_KEY,
        enabled,
        refetchInterval: RELAY_POLL_INTERVALS_MS.tasks,
        queryFn: async ({ signal }: { signal: AbortSignal }): Promise<RelayTaskSummary[]> => {
          const result = await listTasks(signal);
          if (result.flowPolicy) queryClient.setQueryData(["task-flow-policy"], result.flowPolicy);
          return result.tasks ?? [];
        },
      },
      {
        queryKey: PROJECTS_KEY,
        enabled,
        refetchInterval: RELAY_POLL_INTERVALS_MS.tasks,
        queryFn: async ({ signal }: { signal: AbortSignal }): Promise<ProjectRecord[]> =>
          (await listProjects(signal)).projects ?? [],
      },
    ],
  });


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
      void queryClient.resetQueries({ queryKey: RELAY_KEY });
    }
  }, [enabled, queryClient]);

  // Refetch under the new credential whenever the active token changes.
  const previousTokenRef = useRef(token);
  useEffect(() => {
    const previous = previousTokenRef.current;
    previousTokenRef.current = token;
    if (enabled && previous !== token) {
      void queryClient.refetchQueries({ queryKey: RELAY_KEY });
    }
  }, [token, enabled, queryClient]);

  const refresh = useCallback(
    async (_signal?: AbortSignal, tokenOverride?: string) => {
      if (!enabled) return;
      setManualRefreshPending(true);
      if (tokenOverride) overrideRef.current = tokenOverride;
      try {
        await queryClient.refetchQueries({ queryKey: RELAY_KEY });
      } finally {
        overrideRef.current = undefined;
        setManualRefreshPending(false);
      }
    },
    [enabled, queryClient],
  );

  // Optimistic sandbox updates write straight into the cache so callers keep
  // their familiar setState-style API.
  const setSandboxes = useCallback<Dispatch<SetStateAction<SandboxRecord[]>>>(
    (update) => {
      queryClient.setQueryData<SandboxRecord[]>(SANDBOXES_KEY, (current) => {
        const base = current ?? [];
        return typeof update === "function"
          ? (update as (prev: SandboxRecord[]) => SandboxRecord[])(base)
          : update;
      });
    },
    [queryClient],
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
    sandboxes,
    nodes,
    sessions,
    tasks,
    projects,
    projectsStatus,
    projectsError,
    isRefreshing: manualRefreshPending,
    refresh,
    setSandboxes,
    upsertNode,
  };
}
