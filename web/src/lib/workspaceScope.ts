import { computerId, type NodeLike } from './createAgent.ts';
import type { RelayTaskListItem, RelaySession } from '../types.ts';
import { pathForAppState, canonicalBrowserUrl, parseAppPath } from './appRoute.ts';
import type { AppRoute } from './viewTypes.ts';

/** Stable identity survives a daemon re-enrollment; paths alone are never identities. */
export function sessionComputer(session: Pick<RelaySession, 'computerId' | 'daemonNodeId'>, nodes: readonly NodeLike[]): string | null {
  if (session.computerId) return session.computerId;
  const node = nodes.find(n => n.id === session.daemonNodeId);
  return node ? computerId(node) : session.daemonNodeId ? `node:${session.daemonNodeId}` : null;
}

export function taskComputer(task: RelayTaskListItem, nodes: readonly NodeLike[], sessions: readonly RelaySession[] = []): string | null {
  if (task.projectId) return null;
  if (task.workspaceBinding?.computerId) return task.workspaceBinding.computerId;
  if (task.computerId) return task.computerId;
  // Older records predate explicit scope: recover only from recorded execution
  // without choosing an arbitrary Computer.
  for (const id of [...(task.linkedSessionIds ?? [])].reverse()) {
    const session = sessions.find(s => s.id === id);
    if (session) { const identity = sessionComputer(session, nodes); if (identity) return identity; }
  }
  return null;
}

export function computerWorkHref(identity: string, route: AppRoute = 'main', taskId: string | null = null, runId: string | null = null): string {
  return pathForAppState({ route, computerId: identity, mobileView: route === 'main' ? 'threads' : 'chat', sessionId: null, taskId, runId });
}

export function taskWorkspaceHref(task: RelayTaskListItem, identity: string | null, runId?: string | null): string | null {
  const automationId = task.sourceRoutineId ?? (task.isRoutine ? task.id : null);
  const occurrenceId = task.sourceRoutineId ? task.id : runId;
  if (task.projectId) {
    const search = new URLSearchParams(automationId ? { tab: "automations", automation: automationId } : { tab: "tasks", task: task.id });
    if (automationId && occurrenceId) search.set("run", occurrenceId);
    return canonicalBrowserUrl(`/projects/${encodeURIComponent(task.projectId)}`, search.toString());
  }
  return identity ? computerWorkHref(identity, automationId ? "routine" : "backlog", automationId ?? task.id, occurrenceId) : null;
}

/** Record links inherit the workspace of the board rendering them. */
export function recordHrefForLocation(route: 'backlog' | 'routine', taskId: string | null, runId?: string | null, pathname = typeof window === 'undefined' ? '' : window.location.pathname): string {
  const location = parseAppPath(pathname);
  if (location.projectId) {
    const search = new URLSearchParams({ tab: route === 'routine' ? 'automations' : 'tasks' });
    if (taskId) search.set(route === 'routine' ? 'automation' : 'task', taskId);
    if (runId) search.set('run', runId);
    return canonicalBrowserUrl(`/projects/${encodeURIComponent(location.projectId)}`, search.toString());
  }
  return pathForAppState({ route, computerId: location.computerId, mobileView: 'chat', sessionId: null, taskId, runId });
}

/** The sidebar opens global lists until a workspace has been selected. */
export function workspaceNavigationHref(route: AppRoute, identity: string | null, projectId: string | null): string {
  if (["main", "backlog", "routine"].includes(route)) {
    if (projectId) {
      const path = `/projects/${encodeURIComponent(projectId)}`;
      return route === "backlog" ? `${path}?tab=tasks` : route === "routine" ? `${path}?tab=automations` : path;
    }
    if (identity) return computerWorkHref(identity, route);
  }
  return pathForAppState({ route, mobileView: route === "main" ? "threads" : "chat", sessionId: null });
}
