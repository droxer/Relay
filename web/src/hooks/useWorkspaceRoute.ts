import { useEffect } from "react";
import { canonicalBrowserUrl, navigateToAppPath, pathForAppState, type AppLocationState } from "../lib/appRoute";
import { sessionComputer, taskComputer, taskWorkspaceHref } from "../lib/workspaceScope";
import { useLocationSearch } from "./useLocationSearch";
import type { RelayTaskListItem, RelaySession, DaemonNodeMonitorRecord } from "../types";

/** Move old links and mismatched scopes before their records can render. */
export function useWorkspaceRoute({ location, tasks, sessions, nodes, ready, failed = false }: {
  location: AppLocationState | null;
  tasks: RelayTaskListItem[];
  sessions: RelaySession[];
  nodes: DaemonNodeMonitorRecord[];
  ready: boolean;
  failed?: boolean;
}): boolean {
  const search = new URLSearchParams(useLocationSearch() ?? "");
  const workRoute = location && ["main", "backlog", "routine"].includes(location.route);
  const thread = location?.sessionId ? sessions.find(session => session.id === location.sessionId) : null;
  const runId = location?.runId ?? (location?.route === "projects" ? search.get("run") : null);
  const parentId = location?.taskId ?? (location?.route === "projects" && !location.sessionId
    ? search.get("task") ?? search.get("automation") : null);
  const recordId = runId ?? parentId;
  const task = recordId ? tasks.find(candidate => candidate.id === recordId) : null;
  const globalCollection = Boolean(location && !location.computerId && !location.taskId && !location.sessionId
    && ["main", "backlog", "routine"].includes(location.route));
  let destination: string | null = null;
  if (ready && location && !location.notFound) {
    if (thread) {
      const identity = thread.projectId ? null : sessionComputer(thread, nodes);
      if ((thread.projectId ?? null) !== (location.projectId ?? null)
        || (!thread.projectId && identity !== (location.computerId ?? null)) || location.route === "backlog") {
        destination = pathForAppState({
          route: thread.projectId ? "projects" : "main", mobileView: "chat",
          sessionId: thread.id, projectId: thread.projectId, computerId: identity,
        });
        destination = canonicalBrowserUrl(destination, search.toString());
      }
    } else if (!location.sessionId && task && (workRoute || location.route === "projects")) {
      const identity = taskComputer(task, nodes, sessions);
      const automationId = task.sourceRoutineId ?? (task.isRoutine ? task.id : null);
      const expectedRunId = task.sourceRoutineId ? task.id : null;
      const recordRoute = automationId ? "routine" : "backlog";
      // A project record opened from the global Tasks/Automations pages stays
      // there: correcting its address never moves it into the Project.
      const globalRecord = Boolean(task.projectId) && workRoute && !location.computerId && !location.projectId;
      // The global Tasks list also lists Automation runs; one opened there is
      // its own record, so it stays on the Tasks page too.
      const globalTaskRun = globalRecord && location.route === "backlog" && Boolean(task.sourceRoutineId)
        && parentId === task.id && !runId;
      const correctScope = task.projectId
        ? (location.route === "projects" && task.projectId === location.projectId)
          || (globalRecord && (location.route === recordRoute || globalTaskRun))
        : identity === (location.computerId ?? null) && location.route === (automationId ? "routine" : "backlog");
      const correctRecord = globalTaskRun
        || (parentId === (automationId ?? task.id) && (runId ?? null) === expectedRunId);
      if (!correctScope || !correctRecord) {
        const ownedHref = globalRecord
          ? pathForAppState({ route: recordRoute, mobileView: "chat", sessionId: null,
            taskId: automationId ?? task.id, runId: expectedRunId })
          : taskWorkspaceHref(task, identity);
        destination = relocateRecordQuery(ownedHref, location, search);
      }
    }
  }
  useEffect(() => { if (destination) void navigateToAppPath(destination, { replace: true }); }, [destination]);
  return Boolean(destination) || Boolean(workRoute && !location?.notFound && !globalCollection && !location?.computerId && !ready && !failed);
}

/** Keep panel/filter state while replacing the record's workspace coordinates. */
function relocateRecordQuery(destination: string, location: AppLocationState, search: URLSearchParams): string {
  const source = new URL(canonicalBrowserUrl(pathForAppState(location), search.toString()), "http://relay.local");
  const recordTab = source.searchParams.get(location.route === "projects" ? "recordTab" : "tab");
  const target = new URL(destination, source.origin);
  for (const [key, value] of source.searchParams) {
    if (!["project", "task", "automation", "run", "tab", "recordTab"].includes(key)) target.searchParams.set(key, value);
  }
  if (recordTab) target.searchParams.set(target.pathname.startsWith("/projects/") ? "recordTab" : "tab", recordTab);
  return canonicalBrowserUrl(target.pathname, target.searchParams.toString());
}
