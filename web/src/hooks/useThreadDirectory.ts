import { useMemo, useState } from "react";
import type { ProjectRecord } from "../types";
import { matchesThreadQuery, reuseThreadItems, runningAgentName, threadOriginIndex, threadsForDirectory, type ThreadItem, type ThreadParticipant } from "../lib/threads";
import { threadNodeOffline } from "../lib/threadRuntime";

/**
 * What the thread rail shows: the user's threads decorated with live state,
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
type DirectoryNode = {
  activeRuns: readonly { sessionId: string; agent: ThreadItem["runningAgent"]; logicalAgentId?: string }[];
};

/** The rail draws each room's faces, so an agent entry carries a name and an
   image on top of what threadNodeOffline reads. */
type DirectoryAgent = NonNullable<Parameters<typeof threadNodeOffline>[1]>[number] & ThreadParticipant;

interface ThreadDirectory {
  /** Every thread with its running agent and node-offline flag resolved. */
  threadItems: ThreadItem[];
  /** …narrowed by the search query. */
  filteredThreads: ThreadItem[];
  /** Projects to list, on the projects route only. */
  directoryProjects: ProjectRecord[];
  /** Threads to list, grouped for the active route. */
  directoryThreads: ThreadItem[];
}

interface ThreadDirectoryInput {
  route: string;
  myThreads: ThreadItem["session"][];
  projects: readonly ProjectRecord[];
  routedProjectId: string | null;
  threadQuery: string;
  /** Tasks whose linked sessions mark a thread as backlog- or routine-driven. */
  tasks: Parameters<typeof threadOriginIndex>[0];
  visibleNodes: readonly DirectoryNode[];
  runtimeNodes: Parameters<typeof threadNodeOffline>[2];
  logicalAgents: readonly DirectoryAgent[];
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

  // Everything an item reads besides its own session, indexed once per
  // change of the fleet, roster, projects, or task list — a poll every few
  // seconds, never a streamed frame.
  const world = useMemo(() => ({
    logicalAgents,
    runtimeNodes,
    origins,
    runningBy: new Map(
      visibleNodes.flatMap((node) => node.activeRuns.map((run) => [run.sessionId, run] as const)),
    ),
    projectNames: new Map(projects.map((project) => [project.id, project.name])),
    agentsById: new Map(logicalAgents.map((agent) => [agent.id, agent])),
    agentNames: new Map(logicalAgents.map((agent) => [agent.id, agent.displayName])),
    // The item built for each session object, remembered while the world
    // stands still. A streamed frame replaces one session object in the
    // list; every other thread's item — its node-offline resolution walks the
    // fleet and the agent placements — comes straight back from here.
    // Reading the cache in render is safe: a session object is immutable, so
    // the same key always maps to the same answer.
    items: new WeakMap<ThreadItem["session"], ThreadItem>(),
  }), [visibleNodes, logicalAgents, runtimeNodes, origins, projects]);

  // Items are rebuilt whenever any input moves — a node or task poll — but a
  // row is memoized on its item, so each unchanged item keeps its previous
  // object. Without this every row re-rendered on every poll.
  const candidates = useMemo<ThreadItem[]>(() => myThreads.map((session) => {
    const cached = world.items.get(session);
    if (cached) return cached;
    const activeRun = world.runningBy.get(session.id);
    const running = Boolean(activeRun) || session.status === "running";
    const item: ThreadItem = {
      session,
      runningAgent: activeRun?.agent,
      runningAgentName: running ? runningAgentName(session, activeRun, world.agentNames) : undefined,
      nodeOffline: threadNodeOffline(session, world.logicalAgents, world.runtimeNodes),
      origin: world.origins.get(session.id),
      projectName: session.projectId ? world.projectNames.get(session.projectId) ?? session.projectId : undefined,
      // Resolved against the logical agent list, not stored on the session:
      // a renamed or re-imaged agent must not need a session rewrite for the
      // rail to draw its current face.
      participants: (session.participantAgentIds ?? [])
        .map((agentId) => world.agentsById.get(agentId))
        .filter((agent): agent is DirectoryAgent => Boolean(agent)),
    };
    world.items.set(session, item);
    return item;
  }), [myThreads, world]);

  const [held, setHeld] = useState(() => ({ candidates, items: candidates }));
  const threadItems = held.candidates === candidates
    ? held.items
    : reuseThreadItems(held.items, candidates);
  if (held.candidates !== candidates) setHeld({ candidates, items: threadItems });

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
