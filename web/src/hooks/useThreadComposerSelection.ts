import { useEffect, useRef } from "react";
import { useComposerTargetStore } from "../lib/composerTargetStore";
import type { AgentName } from "../types";

interface ThreadComposerSelectionInput {
  sessionId: string | undefined;
  composingNew: boolean;
  targetsReady: boolean;
  teamIds: readonly string[];
  /** The agent the open thread runs (`threadOwnAgentId`), once the roster knows it. */
  threadAgent: { id: string; executorKind: AgentName } | null;
}

/** Restore automatic thread selection too, and validate only a loaded roster. */
export function useThreadComposerSelection({ sessionId, composingNew, targetsReady, teamIds, threadAgent }: ThreadComposerSelectionInput) {
  const restoredSessionId = useRef<string | undefined>(undefined);
  const defaultedSessionId = useRef<string | undefined>(undefined);
  const pendingTeamId = useComposerTargetStore((s) => s.pendingThreadTeamId);
  const restoreThreadPick = useComposerTargetStore((s) => s.restoreThreadPick);
  const defaultThreadPick = useComposerTargetStore((s) => s.defaultThreadPick);
  useEffect(() => {
    const nextId = composingNew ? undefined : sessionId;
    if (nextId === restoredSessionId.current) return;
    restoredSessionId.current = nextId;
    defaultedSessionId.current = undefined;
    if (nextId) restoreThreadPick(nextId);
  }, [composingNew, restoreThreadPick, sessionId]);

  // A thread started by a task, an automation, or another tab has no saved
  // pick; open it on its own agent, once, so a later run or roster refresh
  // never overrides what the person picks next.
  const threadAgentId = threadAgent?.id;
  const threadAgentKind = threadAgent?.executorKind;
  useEffect(() => {
    if (composingNew || !sessionId || !threadAgentId || !threadAgentKind) return;
    if (defaultedSessionId.current === sessionId) return;
    defaultedSessionId.current = sessionId;
    defaultThreadPick(sessionId, { id: threadAgentId, executorKind: threadAgentKind });
  }, [composingNew, defaultThreadPick, sessionId, threadAgentId, threadAgentKind]);

  useEffect(() => {
    if (!targetsReady || (!composingNew && !sessionId)) return;
    // Restoration above may have changed the target during this same commit.
    const state = useComposerTargetStore.getState();
    if (state.pendingThreadTeamId && !teamIds.includes(state.pendingThreadTeamId)) state.clearPendingTeam();
  }, [composingNew, pendingTeamId, sessionId, targetsReady, teamIds]);
}
