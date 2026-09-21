import { useMemo, useRef } from "react";
import type { ProjectRecord } from "../types";
import { matchesThreadQuery, reuseThreadItems, threadOriginIndex, threadsForDirectory, type ThreadItem } from "../lib/threads";
import { threadNodeOffline } from "../lib/threadRuntime";

/**
 * What the thread rail shows: the employee's threads decorated with live state,
 * narrowed by the search box, and — on the projects route — grouped against the
 * project list.
 *
 * Pure derivation, no effects. It was inline in App.tsx as five stacked
 * `useMemo`s whose only relationship to the surrounding 1400 lines was that
 * they happened to be declared there.
 */
/* Nodes and agents are typed structurally against what the derivation reads,
   the same way lib/threadRuntime.ts types its own helpers. Projects are not:
   threadsForDirectory groups on the full record, so a narrower shape here
   would only be a second, weaker spelling of the same model. */
type DirectoryNode = { activeRuns: readonly { sessionId: string; agent: ThreadItem["runningAgent"] }[] };

export interface ThreadDirectory {
  /** Every thread with its running agent and node-offline flag resolved. */
  threadItems: ThreadItem[];
  /** …narrowed by the search query. */
  filteredThreads: ThreadItem[];
  /** Projects to list, on the projects route only. */
  directoryProjects: ProjectRecord[];
  /** Threads to list, grouped for the active route. */
  directoryThreads: ThreadItem[];
}

export interface ThreadDirectoryInput {
  route: string;
  myThreads: ThreadItem["session"][];
  projects: readonly ProjectRecord[];
  routedProjectId: string | null;
  threadQuery: string;
  /** Tasks whose linked sessions mark a thread as backlog- or routine-driven. */
  tasks: Parameters<typeof threadOriginIndex>[0];
  visibleNodes: readonly DirectoryNode[];
  runtimeNodes: Parameters<typeof threadNodeOffline>[2];
  logicalAgents: Parameters<typeof threadNodeOffline>[1];
}

export function useThreadDirectory({
  route,
  myThreads,
  projects,
  routedProjectId,
  threadQuery,
  tasks,
  visibleNodes,
  runtimeNodes,
  logicalAgents,
}: ThreadDirectoryInput): ThreadDirectory {
  const origins = useMemo(() => threadOriginIndex(tasks), [tasks]);

  // Items are rebuilt whenever any input moves — a node or task poll — but a
  // row is memoized on its item, so each unchanged item keeps its previous
  // object. Without this every row re-rendered on every poll.
  const previousItems = useRef<ThreadItem[]>([]);
  const threadItems = useMemo<ThreadItem[]>(() => {
    const runningBy = new Map(
      visibleNodes.flatMap((node) => node.activeRuns.map((run) => [run.sessionId, run.agent] as const)),
    );
    const projectNames = new Map(projects.map(project => [project.id, project.name]));
    const next = reuseThreadItems(previousItems.current, myThreads.map((session) => ({
      session,
      runningAgent: runningBy.get(session.id),
      nodeOffline: threadNodeOffline(session, logicalAgents, runtimeNodes),
      origin: origins.get(session.id),
      projectName: session.projectId ? projectNames.get(session.projectId) ?? session.projectId : undefined,
    })));
    previousItems.current = next;
    return next;
  }, [myThreads, visibleNodes, logicalAgents, runtimeNodes, origins, projects]);

  const filteredThreads = useMemo(
    () => threadItems.filter((item) => matchesThreadQuery(item.session, threadQuery)
      || Boolean(item.projectName?.toLowerCase().includes(threadQuery.trim().toLowerCase()))),
    [threadItems, threadQuery],
  );

  // A project stays listed when it is the routed one, when its own name
  // matches, or when any thread inside it matches — so searching for a thread
  // never hides the project you would have to open to reach it.
  const directoryProjects = useMemo(() => {
    if (route !== "projects") return [];
    const query = threadQuery.trim().toLowerCase();
    if (!query) return [...projects];
    const matchingProjectIds = new Set(
      projects.filter((project) => project.name.toLowerCase().includes(query)).map((project) => project.id),
    );
    return projects.filter(
      (project) =>
        project.id === routedProjectId
        || matchingProjectIds.has(project.id)
        || threadItems.some(
          (item) => item.session.projectId === project.id && matchesThreadQuery(item.session, threadQuery),
        ),
    );
  }, [projects, route, routedProjectId, threadItems, threadQuery]);

  const directoryThreads = useMemo(() => {
    if (route !== "projects") return threadsForDirectory(filteredThreads, projects, "threads");
    const query = threadQuery.trim().toLowerCase();
    const matchingProjectIds = new Set(
      projects.filter((project) => project.name.toLowerCase().includes(query)).map((project) => project.id),
    );
    return threadItems.filter((item) => {
      if (!item.session.projectId || !projects.some((project) => project.id === item.session.projectId)) return false;
      return !query || matchingProjectIds.has(item.session.projectId) || matchesThreadQuery(item.session, threadQuery);
    });
  }, [filteredThreads, projects, route, threadItems, threadQuery]);

  return { threadItems, filteredThreads, directoryProjects, directoryThreads };
}
