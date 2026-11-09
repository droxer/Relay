import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useThreadDispatch, type ThreadDispatchDeps } from "../src/hooks/useThreadDispatch";
import { useComposerTargetStore } from "../src/lib/composerTargetStore";
import { useHandoffStore } from "../src/lib/handoffStore";
import { useRelayStore } from "../src/lib/store";
import { useThreadSendStore } from "../src/lib/threadSendStore";
import type { RelaySession } from "../src/types";

import { setup } from "./threadDispatchSetup";

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
  expect(useThreadSendStore.getState()).toMatchObject({ operations: {} });
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

it.each(["retry", "handoff"] as const)("retains Stop while a %s is being dispatched", async (kind) => {
  const { deps, accept, dispatch, cancel, session } = setup(true);
  deps.effectiveSelectableLogicalAgents = [{
    id: "agent-1", executorKind: "codex", enabled: true, availability: "ready",
  }] as ThreadDispatchDeps["effectiveSelectableLogicalAgents"];
  useHandoffStore.setState({ agentId: "agent-1", open: true, note: "take it from here" });
  deps.requestThreadRecoveryMutation = { mutateAsync: dispatch } as ThreadDispatchDeps["requestThreadRecoveryMutation"];
  const { result, rerender } = renderHook((props) => useThreadDispatch(props), { initialProps: deps });
  let sending!: Promise<void>;
  act(() => {
    sending = kind === "retry"
      ? result.current.retryAgentMessage("codex", "agent-1")
      : result.current.sendHandoff();
  });
  expect(dispatch).toHaveBeenCalledOnce();
  rerender({ ...deps, threadRunning: true });
  await act(async () => { await result.current.cancelActiveRun(); });
  await act(async () => { accept({ ...session, status: "running" }); await sending; });
  expect(cancel).toHaveBeenCalledOnce();
  expect(cancel).toHaveBeenCalledWith(expect.objectContaining({ sessionId: session.id }));
  if (kind === "handoff") {
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({
      input: expect.objectContaining({ targetAgentId: "agent-1", note: "take it from here" }),
    }));
    expect(useHandoffStore.getState()).toMatchObject({ open: false, note: "", agentId: "agent-1" });
  }
});

it.each(["rerun", "handoff"] as const)("reuses the operation id when a %s recovery is retried", async (kind) => {
  const { deps, session } = setup(true);
  deps.effectiveSelectableLogicalAgents = deps.composerLogicalAgents!;
  const recover = vi.fn().mockRejectedValueOnce(new Error("connection lost")).mockResolvedValueOnce(session);
  deps.requestThreadRecoveryMutation = { mutateAsync: recover } as ThreadDispatchDeps["requestThreadRecoveryMutation"];
  useHandoffStore.setState({ agentId: "agent-1", note: "Continue the work" });
  const { result } = renderHook(() => useThreadDispatch(deps));
  const retry = () => kind === "handoff" ? result.current.sendHandoff() : result.current.retryAgentMessage("codex", "agent-1");
  await act(async () => { await retry(); });
  expect(deps.recoveryOperationIdsRef.current.size).toBe(1);
  await act(async () => { await retry(); });
  const first = recover.mock.calls[0][0].input;
  const second = recover.mock.calls[1][0].input;
  expect(first.idempotencyKey).toBeTruthy();
  expect(second.idempotencyKey).toBe(first.idempotencyKey);
  expect(second.kind).toBe(kind);
  expect(deps.recoveryOperationIdsRef.current.size).toBe(0);
});
