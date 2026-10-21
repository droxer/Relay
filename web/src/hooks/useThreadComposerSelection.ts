import { useEffect, useRef } from "react";
import { useComposerTargetStore } from "../lib/composerTargetStore";

interface ThreadComposerSelectionInput {
  sessionId: string | undefined;
  composingNew: boolean;
  targetsReady: boolean;
  teamIds: readonly string[];
}

/** Restore automatic thread selection too, and validate only a loaded roster. */
export function useThreadComposerSelection({ sessionId, composingNew, targetsReady, teamIds }: ThreadComposerSelectionInput) {
  const restoredSessionId = useRef<string | undefined>(undefined);
  const pendingTeamId = useComposerTargetStore((s) => s.pendingThreadTeamId);
  const restoreThreadPick = useComposerTargetStore((s) => s.restoreThreadPick);
  useEffect(() => {
    const nextId = composingNew ? undefined : sessionId;
    if (nextId === restoredSessionId.current) return;
    restoredSessionId.current = nextId;
    if (nextId) restoreThreadPick(nextId);
  }, [composingNew, restoreThreadPick, sessionId]);

  useEffect(() => {
    if (!targetsReady || (!composingNew && !sessionId)) return;
    // Restoration above may have changed the target during this same commit.
    const state = useComposerTargetStore.getState();
    if (state.pendingThreadTeamId && !teamIds.includes(state.pendingThreadTeamId)) state.clearPendingTeam();
  }, [composingNew, pendingTeamId, sessionId, targetsReady, teamIds]);
}
