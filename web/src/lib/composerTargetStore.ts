import { create } from "zustand";
import type { AgentName } from "../types.js";

type AgentTarget = { id: string; executorKind: AgentName };
type NodeUpdate = string | null | ((previous: string | null) => string | null);

/** The composer's last pick in one started thread, restored when it reopens. */
export type ThreadPick =
  | { kind: "agent"; agent: AgentTarget }
  | { kind: "team"; teamId: string }
  | { kind: "room" };

const threadPicksStorageKey = "relay-web.threadComposerPicks";
/** Oldest picks fall off first; a forgotten thread just opens on its room. */
const MAX_THREAD_PICKS = 200;

function isThreadPick(value: unknown): value is ThreadPick {
  if (!value || typeof value !== "object") return false;
  const pick = value as Record<string, unknown>;
  if (pick.kind === "room") return true;
  if (pick.kind === "team") return typeof pick.teamId === "string";
  if (pick.kind !== "agent" || !pick.agent || typeof pick.agent !== "object") return false;
  const agent = pick.agent as Record<string, unknown>;
  return typeof agent.id === "string" && typeof agent.executorKind === "string";
}

function readThreadPicks(): Record<string, ThreadPick> {
  if (typeof localStorage === "undefined") return {};
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(threadPicksStorageKey) ?? "null");
    if (!stored || typeof stored !== "object" || Array.isArray(stored)) return {};
    return Object.fromEntries(
      Object.entries(stored).filter((entry): entry is [string, ThreadPick] => isThreadPick(entry[1])),
    );
  } catch {
    return {};
  }
}

function writeThreadPicks(picks: Record<string, ThreadPick>): void {
  if (typeof localStorage === "undefined") return;
  try { localStorage.setItem(threadPicksStorageKey, JSON.stringify(picks)); }
  catch { /* storage full or blocked: the pick still holds for this tab */ }
}

/** A new copy with `threadId`'s pick moved to the newest slot, capped. */
function withThreadPick(picks: Record<string, ThreadPick>, threadId: string, pick: ThreadPick) {
  const entries = [...Object.entries(picks).filter(([id]) => id !== threadId), [threadId, pick] as const];
  return Object.fromEntries(entries.slice(-MAX_THREAD_PICKS));
}

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
  /** Each started thread's last pick, so reopening it keeps who was chosen
   *  instead of falling back to the whole team. */
  threadPicks: Record<string, ThreadPick>;

  setActiveTarget: (target: AgentTarget | null) => void;
  pickAgent: (agent: AgentTarget) => void;
  pickTeam: (teamId: string) => void;
  pickRoom: () => void;
  clearPendingTeam: () => void;
  setNewThreadNodeId: (update: NodeUpdate) => void;
  /** Record `pick` (default: the current pick) as `threadId`'s last one. */
  rememberThreadPick: (threadId: string, pick?: ThreadPick) => void;
  /** Re-apply `threadId`'s last pick; a thread with none opens on its room. */
  restoreThreadPick: (threadId: string) => void;
}

export const useComposerTargetStore = create<ComposerTargetStore>((set, get) => ({
  activeAgent: "claude",
  activeLogicalAgentId: null,
  pendingThreadTeamId: null,
  projectRoomTarget: true,
  newThreadNodeId: null,
  threadPicks: readThreadPicks(),

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
  rememberThreadPick: (threadId, explicit) => {
    const { pendingThreadTeamId, projectRoomTarget, activeLogicalAgentId, activeAgent, threadPicks } = get();
    const pick: ThreadPick = explicit ?? (pendingThreadTeamId
      ? { kind: "team", teamId: pendingThreadTeamId }
      : !projectRoomTarget && activeLogicalAgentId
      ? { kind: "agent", agent: { id: activeLogicalAgentId, executorKind: activeAgent } }
      : { kind: "room" });
    const next = withThreadPick(threadPicks, threadId, pick);
    writeThreadPicks(next);
    set({ threadPicks: next });
  },
  restoreThreadPick: (threadId) => {
    const pick = get().threadPicks[threadId];
    if (pick?.kind === "agent") {
      get().pickAgent(pick.agent);
    } else if (pick?.kind === "team") {
      set({ pendingThreadTeamId: pick.teamId, projectRoomTarget: true });
    } else {
      set({ pendingThreadTeamId: null, projectRoomTarget: true });
    }
  },
}));
