import { vi } from "vitest";
import { type ThreadDispatchDeps } from "../src/hooks/useThreadDispatch";
import { useComposerTargetStore } from "../src/lib/composerTargetStore";
import { useHandoffStore } from "../src/lib/handoffStore";
import { useRelayStore } from "../src/lib/store";
import { useThreadSendStore } from "../src/lib/threadSendStore";
import type { RelaySession } from "../src/types";

export function setup(existing = false) {
  // Who is addressed and whether a thread is being staged live in stores now;
  // start every case from a clean slate so no pick leaks between tests.
  useHandoffStore.setState(useHandoffStore.getInitialState(), true);
  useThreadSendStore.setState(useThreadSendStore.getInitialState(), true);
  useComposerTargetStore.setState({
    ...useComposerTargetStore.getInitialState(),
    projectRoomTarget: false, activeAgent: "codex", activeLogicalAgentId: "agent-1",
  }, true);
  useRelayStore.setState({ ...useRelayStore.getInitialState(), selectedUser: "alice", composingNew: !existing }, true);
  let accept!: (session: RelaySession) => void;
  let reject!: (error: Error) => void;
  const response = new Promise<RelaySession>((resolve, fail) => { accept = resolve; reject = fail; });
  const session = { id: "thread-1", status: "waiting_for_human" } as RelaySession;
  const cancel = vi.fn().mockResolvedValue({ ...session, status: "cancelled" });
  const dispatch = vi.fn().mockReturnValue(response);
  const deps = {
    activeSession: existing ? session : undefined,
    activeProject: null, activeRun: undefined, activeRunOwner: null, activeRuntimeNode: null,
    threadRunning: false, requiresRuntimeSelection: false, projectDispatchDisabled: false,
    effectiveSelectableLogicalAgents: [],
    composerLogicalAgents: [{ id: "agent-1", executorKind: "codex", availability: "ready", enabled: true }],
    threadMentionCandidates: [{ id: "agent-1", name: "Codex", eligible: true }],
    composerTeams: [],
    selectedUser: "alice", selectedSandbox: undefined, selectedThreadNodeId: "node-1",
    selectedToken: undefined, tokens: {},
    composerRef: { current: { getText: () => "do work", clear: vi.fn(), setText: vi.fn() } },
    transcript: { pinToBottom: vi.fn() },
    messageOperationIdsRef: { current: new Map() }, recoveryOperationIdsRef: { current: new Map() },
    submitThreadMessageMutation: { mutateAsync: dispatch }, runLogicalAgentsMutation: { mutateAsync: dispatch },
    cancelRunMutation: { mutateAsync: cancel },
    syncThreadUrl: vi.fn(), navigateToRoute: vi.fn(), reportMutationError: vi.fn(), t: (key: string) => key,
  } as unknown as ThreadDispatchDeps;
  return { deps, accept, reject, cancel, dispatch, session };
}
