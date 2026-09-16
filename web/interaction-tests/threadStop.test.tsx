import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useThreadDispatch, type ThreadDispatchDeps } from "../src/hooks/useThreadDispatch";
import type { RelaySession } from "../src/types";

function setup(existing = false) {
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
    projectRoomTarget: false, activeAgent: "codex", activeLogicalAgentId: "agent-1",
    effectiveSelectableLogicalAgents: [],
    threadMentionCandidates: [{ id: "agent-1", name: "Codex", eligible: true }],
    composerTeams: [], pendingThreadTeamId: null, handoffAgentId: "", handoffNote: "",
    selectedEmployee: "alice", selectedSandbox: undefined, selectedThreadNodeId: "node-1",
    selectedToken: undefined, tokens: {}, composingNew: !existing,
    composerRef: { current: { getText: () => "do work", clear: vi.fn(), setText: vi.fn() } },
    transcript: { pinToBottom: vi.fn() },
    messageOperationIdsRef: { current: new Map() }, recoveryOperationIdsRef: { current: new Map() },
    submitThreadMessageMutation: { mutateAsync: dispatch }, runLogicalAgentsMutation: { mutateAsync: dispatch },
    cancelRunMutation: { mutateAsync: cancel },
    setActiveAgent: vi.fn(), setActiveLogicalAgentId: vi.fn(), setActiveSessionId: vi.fn(),
    setSelectedSessionId: vi.fn(), setComposingNew: vi.fn(), setPendingThreadTeamId: vi.fn(),
    setPendingUserMessage: vi.fn(), setIsRunning: vi.fn(), setHandoffNote: vi.fn(), setHandoffOpen: vi.fn(),
    syncThreadUrl: vi.fn(), navigateToRoute: vi.fn(), reportMutationError: vi.fn(), t: (key: string) => key,
  } as unknown as ThreadDispatchDeps;
  return { deps, accept, reject, cancel, dispatch, session };
}

describe("composer stop during dispatch", () => {
  it.each([false, true])("stops an accepted run after clicking during a pending send (existing=%s)", async (existing) => {
    const { deps, accept, cancel, dispatch, session } = setup(existing);
    const { result, rerender } = renderHook((props) => useThreadDispatch(props), { initialProps: deps });
    let sending!: Promise<void>;
    act(() => { sending = result.current.sendMessage(); });
    expect(dispatch).toHaveBeenCalledOnce();
    rerender({ ...deps, threadRunning: true });
    await act(async () => { await result.current.cancelActiveRun(); });
    await act(async () => { await result.current.cancelActiveRun(); });
    expect(cancel).not.toHaveBeenCalled();
    await act(async () => { accept({ ...session, status: "running" }); await sending; });
    expect(cancel).toHaveBeenCalledWith(expect.objectContaining({ sessionId: session.id }));
    expect(cancel).toHaveBeenCalledOnce();
  });
});

it("does not cancel a send without a stop request", async () => {
  const { deps, accept, cancel, session } = setup();
  const { result } = renderHook(() => useThreadDispatch(deps));
  await act(async () => {
    const sending = result.current.sendMessage();
    accept({ ...session, status: "running" });
    await sending;
  });
  expect(cancel).not.toHaveBeenCalled();
});

it("clears a pending stop when dispatch fails", async () => {
  const { deps, reject, cancel, dispatch, session } = setup();
  const { result } = renderHook(() => useThreadDispatch(deps));
  await act(async () => {
    const sending = result.current.sendMessage();
    await result.current.cancelActiveRun();
    reject(new Error("offline"));
    await sending;
  });
  expect(cancel).not.toHaveBeenCalled();
  expect(deps.reportMutationError).toHaveBeenCalled();
  expect(deps.setIsRunning).toHaveBeenLastCalledWith(false);
  dispatch.mockResolvedValue({ ...session, status: "running" });
  await act(async () => { await result.current.sendMessage(); });
  expect(cancel).not.toHaveBeenCalled();
});

it("cancels an already running thread immediately", async () => {
  const { deps, cancel, session } = setup(true);
  deps.activeSession = { ...session, status: "running" };
  const { result } = renderHook(() => useThreadDispatch(deps));
  await act(async () => { await result.current.cancelActiveRun(); });
  expect(cancel).toHaveBeenCalledWith(expect.objectContaining({ sessionId: session.id }));
});

it("does not apply a stop in another thread to the pending send", async () => {
  const { deps, accept, cancel, session } = setup(true);
  const { result, rerender } = renderHook((props) => useThreadDispatch(props), { initialProps: deps });
  let sending!: Promise<void>;
  act(() => { sending = result.current.sendMessage(); });
  rerender({ ...deps, activeSession: { ...session, id: "other-thread", status: "running" } });
  await act(async () => { await result.current.cancelActiveRun(); });
  await act(async () => { accept({ ...session, status: "running" }); await sending; });
  expect(cancel).toHaveBeenCalledOnce();
  expect(cancel).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "other-thread" }));
});
