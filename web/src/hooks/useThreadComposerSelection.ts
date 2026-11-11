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
  roleBindingKey?: string;
  threadAgent?: { id: string; executorKind: AgentName } | null;
}

/** Restore automatic thread selection too, and validate only a loaded roster. */
export function useThreadComposerSelection({ sessionId, composingNew, targetsReady, threadDetailsReady = true, teamIds, threadAgent, roleBindingKey }: ThreadComposerSelectionInput) {
  const restoredSessionId = useRef<string | undefined>(undefined);
  const restoredBinding = useRef<string | undefined>(undefined);
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

  useEffect(() => {
    if (composingNew || !sessionId || roleBindingKey === undefined || !targetsReady) return;
    const key = `${sessionId}:${roleBindingKey}`;
    if (restoredBinding.current === key) return;
    restoredBinding.current = key;
    const state = useComposerTargetStore.getState();
    if (threadAgent) {
      state.pickAgent(threadAgent);
      state.rememberThreadPick(sessionId, {kind:"agent",agent:threadAgent});
    } else {
      state.pickRoom();
      state.rememberThreadPick(sessionId, {kind:"room"});
    }
  }, [composingNew, sessionId, roleBindingKey, threadAgent, targetsReady]);

  // A thread started by a task, an automation, or another tab has no saved
  // pick; open it on its own agent, once, so a later run or roster refresh
  // never overrides what the person picks next.
  const threadAgentId = threadAgent?.id;
  const threadAgentKind = threadAgent?.executorKind;
  useEffect(() => {
    if (composingNew || !sessionId || !threadAgentId || !threadAgentKind || !threadDetailsReady) return;
    if (defaultedSessionId.current === sessionId) return;
    defaultedSessionId.current = sessionId;
    defaultThreadPick(sessionId, { id: threadAgentId, executorKind: threadAgentKind });
  }, [composingNew, defaultThreadPick, sessionId, threadAgentId, threadAgentKind, threadDetailsReady]);

  useEffect(() => {
    if (!targetsReady || (!composingNew && !sessionId)) return;
    // Restoration above may have changed the target during this same commit.
    const state = useComposerTargetStore.getState();
    if (state.pendingThreadTeamId && !teamIds.includes(state.pendingThreadTeamId)) state.clearPendingTeam();
  }, [composingNew, pendingTeamId, sessionId, targetsReady, teamIds]);
}
