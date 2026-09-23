import { create } from "zustand";
import type { AgentName } from "../types.js";

type AgentTarget = { id: string; executorKind: AgentName };
type NodeUpdate = string | null | ((previous: string | null) => string | null);

// Who the composer's next message goes to, and where a brand-new thread runs.
// Picked in the composer, kept routable by App as the roster changes, and read
// at send time by useThreadDispatch — which used to receive every field and
// setter here as a separate dependency.
interface ComposerTargetStore {
  /** Executor kind of the addressed agent; survives the target clearing. */
  activeAgent: AgentName;
  activeLogicalAgentId: string | null;
  /** Team picked while staging a brand-new thread. */
  pendingThreadTeamId: string | null;
  /** A project thread addresses its whole roster until one member is picked. */
  projectRoomTarget: boolean;
  /** Computer picked for a brand-new thread. */
  newThreadNodeId: string | null;

  setActiveTarget: (target: AgentTarget | null) => void;
  pickAgent: (agent: AgentTarget) => void;
  pickTeam: (teamId: string) => void;
  pickRoom: () => void;
  clearPendingTeam: () => void;
  setNewThreadNodeId: (update: NodeUpdate) => void;
}

export const useComposerTargetStore = create<ComposerTargetStore>((set, get) => ({
  activeAgent: "claude",
  activeLogicalAgentId: null,
  pendingThreadTeamId: null,
  projectRoomTarget: true,
  newThreadNodeId: null,

  setActiveTarget: (target) => set(target
    ? { activeLogicalAgentId: target.id, activeAgent: target.executorKind }
    : { activeLogicalAgentId: null }),
  pickAgent: (agent) => set({
    pendingThreadTeamId: null,
    projectRoomTarget: false,
    activeLogicalAgentId: agent.id,
    activeAgent: agent.executorKind,
  }),
  pickTeam: (pendingThreadTeamId) => set({ pendingThreadTeamId }),
  pickRoom: () => set({ projectRoomTarget: true }),
  clearPendingTeam: () => set({ pendingThreadTeamId: null }),
  setNewThreadNodeId: (update) => {
    const previous = get().newThreadNodeId;
    const next = typeof update === "function" ? update(previous) : update;
    if (next !== previous) set({ newThreadNodeId: next });
  },
}));
