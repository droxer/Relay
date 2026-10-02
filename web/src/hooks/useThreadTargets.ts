import { useMemo } from "react";
import type { AgentTeam, EmployeeAgent, RelaySession } from "../types";
import {
  agentsForThreadNode,
  assignableThreadComputers,
  selectableThreadComputers,
  teamsForThreadNode,
  threadComputerSignature,
  threadNeedsRuntimeSelection,
  threadRuntimeNodeId,
} from "../lib/threadRuntime";
import { useStableValue } from "./useStableValue";

/**
 * Who and what the open thread can address: which computer it runs on, and the
 * agents and teams reachable from that computer.
 *
 * One derivation because the answers are interlocked — the agent list is the
 * agents placed on the picked computer, and the team list is the teams whose
 * whole roster is placed there. Splitting them would let the composer's picker
 * and the `@`-mention list drift apart, which is precisely what "one list keeps
 * the two selections in sync" prevents.
 */
/* Generic over the node record so the caller keeps its own richer type: the
   lib helpers are `<T extends ThreadComputer>` and erasing that here handed
   the composer a base ThreadComputer where it needed the full monitor record. */
type ThreadComputerLike = Parameters<typeof assignableThreadComputers>[0][number];

export interface ThreadTargets<N extends ThreadComputerLike> {
  /** Every machine this employee could run on, live or not. */
  assignableComputers: N[];
  /** …narrowed to the ones that can take work right now. */
  selectableComputers: N[];
  /** `selectableComputers`, held stable across heartbeats. */
  threadComputers: N[];
  /** True while the composer is still choosing a computer for a new thread. */
  initializingThread: boolean;
  /** The computer the thread will run on: the pick, or the one it is pinned to. */
  selectedThreadNodeId: string | null;
  /** The pinned computer's record, for a thread that has already started. */
  activeRuntimeNode: N | null;
  /** The picked computer's record, for a thread that has not. Stable. */
  selectedThreadComputer: N | null;
  /** Agents placed on the selected computer. */
  selectableLogicalAgents: EmployeeAgent[];
  /** Teams whose whole roster is placed there, plus a started thread's own. */
  composerTeams: AgentTeam[];
  /** The room, in join order. */
  threadParticipants: EmployeeAgent[];
}

interface ThreadTargetsInput<N extends ThreadComputerLike> {
  activeSession: RelaySession | undefined;
  composingNew: boolean;
  logicalAgents: EmployeeAgent[];
  newThreadNodeId: string | null;
  runtimeNodes: readonly N[];
  selectedEmployee: string;
  teams: AgentTeam[];
}

export function useThreadTargets<N extends ThreadComputerLike>({
  activeSession,
  composingNew,
  logicalAgents,
  newThreadNodeId,
  runtimeNodes,
  selectedEmployee,
  teams,
}: ThreadTargetsInput<N>): ThreadTargets<N> {
  // Every machine this employee could run on, live or not. A pick is allowed
  // to survive inside this set and nowhere else: the fleet list spans
  // employees and keeps tombstones for deleted nodes, so "still listed" is not
  // "still mine to use".
  const assignableComputers = useMemo(
    () => assignableThreadComputers(runtimeNodes, selectedEmployee),
    [runtimeNodes, selectedEmployee],
  );
  const selectableComputers = useMemo(
    () => selectableThreadComputers(runtimeNodes, selectedEmployee),
    [runtimeNodes, selectedEmployee],
  );
  // Held stable across polls: the picker only reads ids and display names, so
  // a heartbeat that merely refreshed `lastSeenAt` must not hand it a new
  // array and re-render the composer every few seconds.
  const threadComputers = useStableValue(
    selectableComputers,
    threadComputerSignature(selectableComputers),
  );

  const activeThreadNodeId = threadRuntimeNodeId(activeSession, logicalAgents, runtimeNodes);
  const initializingThread = threadNeedsRuntimeSelection(
    activeSession,
    composingNew,
    logicalAgents,
    runtimeNodes,
  );
  const selectedThreadNodeId = initializingThread ? newThreadNodeId : activeThreadNodeId ?? null;

  // Resolved from the unfiltered runtime list, not `threadComputers`: a thread
  // stays pinned to its computer even after that machine goes busy or offline,
  // and those are exactly the moments the readout has to keep naming it.
  const activeRuntimeNode = useMemo(
    () => (initializingThread || !activeThreadNodeId
      ? null
      : runtimeNodes.find((node) => node.id === activeThreadNodeId) ?? null),
    [activeThreadNodeId, initializingThread, runtimeNodes],
  );

  // Same resolution for the pick on a not-yet-started thread, so the trigger
  // keeps naming the chosen computer through a poll that drops it from the
  // selectable set — but only within this employee's own machines, so the
  // trigger can never name someone else's. Held stable so the memoized picker
  // ignores heartbeats.
  const pickedComputer = useMemo(
    () => (initializingThread && selectedThreadNodeId
      ? assignableComputers.find((node) => node.id === selectedThreadNodeId) ?? null
      : null),
    [assignableComputers, initializingThread, selectedThreadNodeId],
  );
  const selectedThreadComputer = useStableValue(
    pickedComputer,
    pickedComputer ? threadComputerSignature([pickedComputer]) : "",
  );

  const selectableLogicalAgents = useMemo(
    () => agentsForThreadNode(logicalAgents, selectedThreadNodeId),
    [logicalAgents, selectedThreadNodeId],
  );

  // Teams follow the same rule as agents: only offer a team whose whole
  // roster is placed on the picked computer. A started team thread keeps its
  // team listed so the locked picker still names it even if a placement moved.
  const startedThreadTeamId = activeSession?.teamId ?? null;
  const composerTeams = useMemo(() => {
    const nodeTeams = teamsForThreadNode(teams, logicalAgents, selectedThreadNodeId);
    if (startedThreadTeamId && !nodeTeams.some((team) => team.id === startedThreadTeamId)) {
      const started = teams.find((team) => team.id === startedThreadTeamId && !team.deletedAt);
      if (started) return [started, ...nodeTeams];
    }
    return nodeTeams;
  }, [teams, logicalAgents, selectedThreadNodeId, startedThreadTeamId]);

  // The room, in join order. Ids the roster names but the agent list does not
  // know (deleted, or another employee's) are dropped rather than rendered as
  // a nameless chip.
  const threadParticipants = useMemo(
    () => (activeSession?.participantAgentIds ?? [])
      .map((agentId) => logicalAgents.find((agent) => agent.id === agentId))
      .filter((agent): agent is EmployeeAgent => Boolean(agent)),
    [activeSession?.participantAgentIds, logicalAgents],
  );

  return {
    assignableComputers,
    selectableComputers,
    threadComputers,
    initializingThread,
    selectedThreadNodeId,
    activeRuntimeNode,
    selectedThreadComputer,
    selectableLogicalAgents,
    composerTeams,
    threadParticipants,
  };
}
