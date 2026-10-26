import { computerId } from "./createAgent.ts";

type ThreadComputer = {
  id: string;
  managedNodeId?: string;
  retiredAt?: string;
  userId?: string;
  workspaceId?: string;
  online: boolean;
  stale: boolean;
  status: string;
};

type ThreadRuntimeSession = {
  daemonNodeId?: string;
  computerId?: string;
  managedNodeId?: string;
  agentRuns: ReadonlyArray<{ agent: string; daemonNodeId?: string; logicalAgentId?: string }>;
};

type ThreadAgent = {
  id: string;
  placements: ReadonlyArray<{
    daemonNodeId: string;
    runtimeNodeId?: string;
    computerId?: string;
    desiredState: string;
  }>;
};

/**
 * Every computer this user could ever run a thread on, live or not.
 *
 * The fleet list spans users (an admin's `/daemon-nodes` returns every
 * machine they own) and keeps a tombstone row for a deleted node, so "still in
 * the fleet" is not the same question as "still this user's to use". This
 * is the set a pick is allowed to survive in; `selectableThreadComputers`
 * narrows it further to what can take work right now.
 */
export function assignableThreadComputers<T extends ThreadComputer>(
  nodes: readonly T[],
  userId: string,
): T[] {
  return nodes.filter(
    (node) => node.userId === userId
      && !node.retiredAt
      && node.status !== "deleted",
  );
}

export function selectableThreadComputers<T extends ThreadComputer>(
  nodes: readonly T[],
  userId: string,
): T[] {
  return assignableThreadComputers(nodes, userId).filter(
    (node) => node.online
      && !node.stale
      && ["ready", "running", "busy"].includes(node.status),
  );
}

/**
 * Content key for a computer list, covering only what the picker renders and
 * routes on.
 *
 * The node poll runs every few seconds and every response carries fresh
 * `lastSeenAt` / `lastSeenAgeMs` / `activeRuns` values, so a naive
 * `useMemo([nodes])` hands the composer a new array on every tick and
 * re-renders the picker forever. Keying on this signature means a poll that
 * changed nothing the picker can see produces no work at all.
 *
 * `nodeLocation` is in the key because the rows and the trigger draw their
 * ownership mark from it: a node whose location resolves while it is already
 * on the list would otherwise keep the pending ring.
 */
export function threadComputerSignature(
  nodes: readonly (ThreadComputer & { displayName?: string; nodeLocation?: string })[],
): string {
  return nodes
    .map((node) => `${node.id}:${node.displayName ?? ""}:${node.nodeLocation ?? ""}`)
    .join("|");
}

/**
 * Which computer a new thread should target, given the previous choice.
 *
 * Returns the previous choice whenever that computer is still assignable, even
 * if the latest poll reports it unselectable. Staleness is a time threshold the
 * daemon heartbeat crosses and re-crosses, so a node flapping out of the
 * selectable set for one poll used to silently reassign the user's thread to
 * whichever computer happened to sort first.
 *
 * `assignable` must be the *user-scoped* list, not the raw fleet: a pick
 * that outlives a switch to another user, or a node that has since been
 * deleted, would otherwise stick and be dispatched to.
 */
export function resolveNewThreadComputer(
  previousId: string | null,
  selectable: readonly ThreadComputer[],
  assignable: readonly ThreadComputer[],
): string | null {
  if (previousId && assignable.some((node) => node.id === previousId)) return previousId;
  return selectable[0]?.id ?? null;
}

export function agentsForThreadNode<T extends ThreadAgent>(
  agents: readonly T[],
  daemonNodeId: string | null | undefined,
): T[] {
  if (!daemonNodeId) return [];
  return agents.filter((agent) => agent.placements.some(
    (placement) => (placement.runtimeNodeId || placement.daemonNodeId) === daemonNodeId
      && placement.desiredState === "active",
  ));
}

type ThreadTeam = {
  id: string;
  deletedAt?: string;
  memberAgentIds: string[];
};

/**
 * Teams align with the picked computer the same way agents do: a team can
 * only take a thread on a computer that hosts its whole roster, since team
 * dispatch is a lead-first pipeline across every member. Members are matched
 * by id against the user's agents, which carry the placements.
 */
export function teamsForThreadNode<T extends ThreadTeam>(
  teams: readonly T[],
  agents: readonly ThreadAgent[],
  daemonNodeId: string | null | undefined,
): T[] {
  if (!daemonNodeId) return [];
  const hostedAgentIds = new Set(
    agentsForThreadNode(agents, daemonNodeId).map((agent) => agent.id),
  );
  return teams.filter(
    (team) => !team.deletedAt
      && team.memberAgentIds.length > 0
      && team.memberAgentIds.every((agentId) => hostedAgentIds.has(agentId)),
  );
}

type ThreadRoster = {
  leadAgentId?: string | null;
  memberAgentIds: readonly string[];
};

type ThreadRosterTeam = {
  id: string;
  deletedAt?: string;
  leadAgentId?: string | null;
  memberAgentIds: readonly string[];
};

/** Return a thread's current team roster, or an empty locked roster if gone. */
export function teamRosterForThread<T extends ThreadRosterTeam>(
  teamId: string | null | undefined,
  teams: readonly T[],
): ThreadRoster | null {
  if (!teamId) return null;
  const team = teams.find((candidate) => candidate.id === teamId && !candidate.deletedAt);
  return team
    ? { leadAgentId: team.leadAgentId, memberAgentIds: team.memberAgentIds }
    : { memberAgentIds: [] };
}

/**
 * The agents a thread may actually address.
 *
 * A team or project thread refuses a non-member outright — the backend answers
 * `agent_forbidden` — so the composer's `@` popup and the handoff picker must
 * offer the roster, not every agent the user owns. A thread with no roster
 * is unrestricted and keeps the list it was given. Members are returned lead
 * first, matching dispatch order, and roster ids the agent list cannot name
 * (deleted, or another user's) are dropped rather than offered as a
 * pick that cannot resolve.
 */
export function addressableThreadAgents<T extends { id: string; deletedAt?: string }>(
  agents: readonly T[],
  roster: ThreadRoster | null,
): T[] {
  if (!roster) return [...agents];
  const byId = new Map(agents.filter((agent) => !agent.deletedAt).map((agent) => [agent.id, agent]));
  const ordered = [
    ...roster.memberAgentIds.filter((agentId) => agentId === roster.leadAgentId),
    ...roster.memberAgentIds.filter((agentId) => agentId !== roster.leadAgentId),
  ];
  return ordered.flatMap((agentId) => {
    const agent = byId.get(agentId);
    return agent ? [agent] : [];
  });
}

export function threadRuntimeNodeId(
  session: ThreadRuntimeSession | undefined,
  agents: readonly ThreadAgent[] = [],
  nodes: readonly ThreadComputer[] = [],
): string | undefined {
  const sameComputer = computerNodeId(session?.computerId, nodes);
  if (sameComputer) return sameComputer;
  const originalNode = nodes.find((node) => node.id === session?.daemonNodeId);
  const managedNodeId = session?.managedNodeId ?? originalNode?.managedNodeId;
  if (managedNodeId) {
    const candidates = nodes.filter(
      (node) => node.managedNodeId === managedNodeId && !node.retiredAt,
    );
    const current = candidates.find(
      (node) => node.managedNodeId === managedNodeId
        && node.online
        && !node.stale
        && ["ready", "running", "busy"].includes(node.status),
    ) ?? candidates[0];
    if (current) return current.id;
  }
  const runs = [...(session?.agentRuns ?? [])].reverse();
  if (session?.daemonNodeId) {
    for (const run of runs) {
      if (!run.logicalAgentId) continue;
      const agent = agents.find((item) => item.id === run.logicalAgentId);
      const placement = agent?.placements.find((item) => item.desiredState === "active");
      const runtimeNodeId = placement?.runtimeNodeId || placement?.daemonNodeId;
      if (!placement || !runtimeNodeId || runtimeNodeId === session.daemonNodeId) continue;
      const reboundNode = nodes.find((node) => node.id === runtimeNodeId);
      if (
        reboundNode?.managedNodeId
        && (!originalNode || originalNode.managedNodeId === reboundNode.managedNodeId)
      ) return runtimeNodeId;
    }
    return session.daemonNodeId;
  }
  const stamped = runs.find((run) => run.daemonNodeId)?.daemonNodeId;
  if (stamped) return stamped;
  // Threads that predate node stamping name no computer anywhere — but the
  // agent that ran still has an active placement, which is where the work
  // happened. Infer the pinned computer from the latest such run.
  for (const run of runs) {
    if (!run.logicalAgentId) continue;
    const agent = agents.find((item) => item.id === run.logicalAgentId);
    const placement = agent?.placements.find((item) => item.desiredState === "active");
    if (placement) return placement.runtimeNodeId || placement.daemonNodeId;
  }
  return undefined;
}

/**
 * The node currently serving a thread's stable Computer identity. A computer
 * that disconnects and comes back under a new node id is still the same
 * computer, so its thread follows it instead of staying on the retired row.
 */
function computerNodeId(
  identity: string | undefined,
  nodes: readonly ThreadComputer[],
): string | undefined {
  if (!identity || identity.startsWith("node:")) return undefined;
  const candidates = nodes.filter((node) => !node.retiredAt && computerId(node) === identity);
  return (candidates.find(isLiveComputer) ?? candidates[0])?.id;
}

function isLiveComputer(node: ThreadComputer): boolean {
  return node.online && !node.stale && ["ready", "running", "busy"].includes(node.status);
}

/**
 * Whether the computer a thread is pinned to is currently unreachable, so the
 * thread list can badge the row. Threads with no resolvable computer (brand
 * new, or predating node stamping with no agent placement) report false —
 * there is nothing to point the indicator at. A pinned computer that has
 * vanished from the fleet entirely counts as offline.
 */
export function threadNodeOffline(
  session: ThreadRuntimeSession | undefined,
  agents: readonly ThreadAgent[] = [],
  nodes: readonly ThreadComputer[] = [],
): boolean {
  const nodeId = threadRuntimeNodeId(session, agents, nodes);
  if (!nodeId) return false;
  const node = nodes.find((item) => item.id === nodeId);
  if (!node || node.retiredAt) return true;
  return !node.online || node.stale;
}

export function threadNeedsRuntimeSelection(
  session: ThreadRuntimeSession | undefined,
  composingNew: boolean,
  agents: readonly ThreadAgent[] = [],
  nodes: readonly ThreadComputer[] = [],
): boolean {
  return composingNew || !threadRuntimeNodeId(session, agents, nodes);
}

type OwnAgentRound = {
  workScope?: { kind: "thread" } | { kind: "task"; taskId: string };
  assignments: readonly { agentId: string }[];
};

/**
 * The agent a thread's composer opens on, so it starts on the agent doing the
 * thread's work rather than on whatever was picked last elsewhere. A plain
 * thread answers whoever ran its latest turn, else the first agent in its
 * room. A project thread answers the agent of its latest task round when one
 * agent ran it — a task assigned to that agent — and null otherwise, as does
 * a team thread: their room is the default target.
 */
export function threadOwnAgentId(
  session: {
    teamId?: string;
    projectId?: string;
    participantAgentIds?: readonly string[];
    agentRuns?: readonly { logicalAgentId?: string }[];
    collaborationRounds?: readonly OwnAgentRound[];
  } | undefined,
): string | null {
  if (!session || session.teamId) return null;
  if (session.projectId) return projectTaskAgentId(session.collaborationRounds ?? []);
  const runs = session.agentRuns ?? [];
  for (let index = runs.length - 1; index >= 0; index -= 1) {
    const id = runs[index]?.logicalAgentId;
    if (id) return id;
  }
  return session.participantAgentIds?.[0] ?? null;
}

function projectTaskAgentId(rounds: readonly OwnAgentRound[]): string | null {
  const taskRound = [...rounds].reverse().find((round) => round.workScope?.kind === "task");
  const agentIds = new Set(taskRound?.assignments.map((assignment) => assignment.agentId));
  return agentIds.size === 1 ? [...agentIds][0] : null;
}
