import { useEffect, useRef } from "react";
import { useComposerTargetStore } from "../lib/composerTargetStore";
import type { AgentName } from "../types";

interface ThreadComposerSelectionInput {
  sessionId: string | undefined;
  composingNew: boolean;
  targetsReady: boolean;
  /** Summary participants cannot identify the agent of the latest task run. */
  threadDetailsReady?: boolean;
  teamIds: readonly string[];
  /** The agent the open thread runs (`threadOwnAgentId`), once the roster knows it. */
  projectLeadDiscussion?: boolean;
  threadAgent?: { id: string; executorKind: AgentName } | null;
}

/** Restore automatic thread selection too, and validate only a loaded roster. */
export function useThreadComposerSelection({ sessionId, composingNew, targetsReady, threadDetailsReady = true, teamIds, threadAgent, projectLeadDiscussion = false }: ThreadComposerSelectionInput) {
  const restoredSelection = useRef<{ sessionId: string | undefined; projectLeadDiscussion: boolean } | undefined>(undefined);
  const defaultedSessionId = useRef<string | undefined>(undefined);
  const pendingTeamId = useComposerTargetStore((s) => s.pendingThreadTeamId);
  const restoreThreadPick = useComposerTargetStore((s) => s.restoreThreadPick);
  const defaultThreadPick = useComposerTargetStore((s) => s.defaultThreadPick);
  useEffect(() => {
    const nextId = composingNew ? undefined : sessionId;
    const previous = restoredSelection.current;
    if (nextId === previous?.sessionId && projectLeadDiscussion === previous?.projectLeadDiscussion) return;
    restoredSelection.current = { sessionId: nextId, projectLeadDiscussion };
    defaultedSessionId.current = undefined;
    if (nextId) restoreThreadPick(nextId, projectLeadDiscussion);
  }, [composingNew, projectLeadDiscussion, restoreThreadPick, sessionId]);

  // A thread started by a task, an automation, or another tab has no saved
  // pick; open it on its own agent, once, so a later run or roster refresh
  // never overrides what the person picks next.
  const threadAgentId = threadAgent?.id;
  const threadAgentKind = threadAgent?.executorKind;
  useEffect(() => {
    if (composingNew || projectLeadDiscussion || !sessionId || !threadAgentId || !threadAgentKind || !threadDetailsReady) return;
    if (defaultedSessionId.current === sessionId) return;
    defaultedSessionId.current = sessionId;
    defaultThreadPick(sessionId, { id: threadAgentId, executorKind: threadAgentKind });
  }, [composingNew, defaultThreadPick, projectLeadDiscussion, sessionId, threadAgentId, threadAgentKind, threadDetailsReady]);

  useEffect(() => {
    if (!targetsReady || (!composingNew && !sessionId)) return;
    // Restoration above may have changed the target during this same commit.
    const state = useComposerTargetStore.getState();
    if (state.pendingThreadTeamId && !teamIds.includes(state.pendingThreadTeamId)) state.clearPendingTeam();
  }, [composingNew, pendingTeamId, sessionId, targetsReady, teamIds]);
}
