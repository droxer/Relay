"use client";

import { useMemo } from "react";
import type { AgentName, AgentTeam, ProjectRecord, RelaySession, UserAgent } from "../types";
import { preferredRoutableAgent } from "../lib/agentDisplayNames";
import { mentionCandidates } from "../lib/mentions";
import { threadRoundTeam } from "../lib/messageRouting";
import { projectThreadRoster } from "../lib/taskAssignment";
import { addressableThreadAgents, teamRosterForThread } from "../lib/threadRuntime";

interface ComposerRoutingInput {
  activeSession: RelaySession | undefined;
  activeProject: ProjectRecord | null;
  teams: AgentTeam[];
  logicalAgents: UserAgent[];
  /** Every agent on the thread's computer (useThreadTargets). */
  selectableLogicalAgents: UserAgent[];
  initializingThread: boolean;
  chosenExecutor: AgentName;
  chosenAgentId: string | null;
  pendingThreadTeamId: string | null;
  projectRoomTarget: boolean;
}

/**
 * Who the composer, the `@` list, and recovery may address in the open
 * thread, and which agent or team the next round goes to.
 */
export function useComposerRouting({
  activeSession,
  activeProject,
  teams,
  logicalAgents,
  selectableLogicalAgents,
  initializingThread,
  chosenExecutor,
  chosenAgentId,
  pendingThreadTeamId,
  projectRoomTarget,
}: ComposerRoutingInput) {
  // Recovery (rerun / handoff) repairs a team's own work, so in a team thread
  // it answers only the team's members. A project thread answers its crew and
  // every other agent on the project's computer (a member the project disabled
  // stays out). A new round is different: the thread is pinned to a computer,
  // not a roster, so the composer and `@` reach every agent on that computer.
  const activeTeamRoster = useMemo(
    () => teamRosterForThread(activeSession?.teamId, teams),
    [activeSession?.teamId, teams],
  );
  const effectiveSelectableLogicalAgents = useMemo(() => {
    if (activeProject) {
      return addressableThreadAgents(logicalAgents, projectThreadRoster(activeProject, logicalAgents));
    }
    if (activeTeamRoster) {
      return addressableThreadAgents(selectableLogicalAgents, activeTeamRoster);
    }
    return selectableLogicalAgents;
  }, [activeProject, activeTeamRoster, logicalAgents, selectableLogicalAgents]);
  const composerLogicalAgents = activeProject
    ? effectiveSelectableLogicalAgents
    : selectableLogicalAgents;
  const activeTarget = preferredRoutableAgent(composerLogicalAgents, chosenAgentId);
  const activeLogicalAgentId = activeTarget?.id ?? null;
  const activeAgent = activeTarget?.executorKind ?? chosenExecutor;
  const threadMentionCandidates = useMemo(
    () => mentionCandidates(composerLogicalAgents),
    [composerLogicalAgents],
  );
  const requiresRuntimeSelection = initializingThread && !activeProject;
  // The team this round runs, for the picker: a staged pick, another team
  // picked in a started thread, or a team thread's own team while the whole
  // room is the target.
  const roundTeamId = activeProject
    ? null
    : requiresRuntimeSelection
    ? pendingThreadTeamId
    : threadRoundTeam({
        threadTeamId: activeSession?.teamId,
        pickedTeamId: pendingThreadTeamId,
        roomTarget: projectRoomTarget,
      }).teamId;

  return {
    effectiveSelectableLogicalAgents,
    composerLogicalAgents,
    activeLogicalAgentId,
    activeAgent,
    threadMentionCandidates,
    requiresRuntimeSelection,
    roundTeamId,
  };
}
