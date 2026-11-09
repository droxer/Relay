import { useRef } from "react";
import { useComposer, threadDraftKey } from "../src/hooks/useComposer";
import type { ComposerHandle } from "../src/components/composer/Composer";
import { act, renderHook } from "@testing-library/react";
import { expect, it } from "vitest";
import type { TFunction } from "i18next";
import { setup } from "./threadDispatchSetup";
import { useThreadDispatch } from "../src/hooks/useThreadDispatch";
import { useThreadTranscript } from "../src/hooks/useThreadTranscript";
import { useHandoffStore } from "../src/lib/handoffStore";
import { useRelayStore } from "../src/lib/store";
import { useThreadSendStore, threadSendKey } from "../src/lib/threadSendStore";
import type { RelaySession } from "../src/types";
it("late A response preserves the newer selection B", async () => {
  const { deps, accept, session } = setup(true);
  useRelayStore.getState().openSession(session.id);
  const { result, rerender } = renderHook((props) => useThreadDispatch(props), { initialProps: deps });
  let sending!: Promise<boolean>;
  act(() => { sending = result.current.sendMessage(); });
  const other = { ...session, id: "thread-B" };
  act(() => {
    useRelayStore.getState().openSession(other.id);
  });
  rerender({ ...deps, activeSession: other });
  await act(async () => { accept({ ...session, status: "running" }); await sending; });
  expect(useRelayStore.getState().activeSessionId).toBe(other.id);
  expect(deps.syncThreadUrl).toHaveBeenCalledTimes(1);
});

it("A send does not echo or mark idle B running, and survives returning to A", () => {
  setup(true);
  const a = { id: "thread-A", taskGoal: "A goal", createdAt: "2026-11-09", events: [] } as unknown as RelaySession;
  const b = { ...a, id: "thread-B", taskGoal: "B goal" };
  useThreadSendStore.getState().beginSend(threadSendKey("alice", a.id), { id: "A-msg", text: "only A" });
  const t = ((key: string) => key) as TFunction;
  const { result, rerender } = renderHook(({ session }) => useThreadTranscript(session, [], t), { initialProps: { session: a } });
  expect(result.current.pendingUserMessage?.text).toBe("only A");
  rerender({ session: b });
  expect(result.current.pendingUserMessage).toBeNull();
  expect(result.current.threadRunning).toBe(false);
  rerender({ session: a });
  expect(result.current.pendingUserMessage?.text).toBe("only A");
  expect(result.current.threadRunning).toBe(true);
});

it.each([false, true])("new Thread result follows only its own draft (leave=%s)", async (leave) => {
  const { deps, accept, session } = setup();
  const { result } = renderHook(() => useThreadDispatch(deps));
  let sending!: Promise<boolean>;
  act(() => { sending = result.current.sendMessage(); });
  if (leave) act(() => useRelayStore.getState().startComposing());
  await act(async () => { accept(session); await sending; });
  expect(useRelayStore.getState().activeSessionId).toBe(leave ? null : session.id);
  expect(deps.syncThreadUrl).toHaveBeenCalledTimes(leave ? 1 : 2);
  expect(useThreadSendStore.getState().operations[threadSendKey("alice", session.id)]?.dispatching).toBe(false);
});

it("a late rejection leaves B's composer and concurrent send untouched", async () => {
  const { deps, reject, session } = setup(true);
  useRelayStore.getState().openSession(session.id);
  const { result, rerender } = renderHook((props) => useThreadDispatch(props), { initialProps: deps });
  let sending!: Promise<boolean>;
  act(() => { sending = result.current.sendMessage(); });
  const other = { ...session, id: "B" };
  act(() => useRelayStore.getState().openSession(other.id));
  rerender({ ...deps, activeSession: other });
  const key = threadSendKey("alice", other.id);
  act(() => { useThreadSendStore.getState().beginSend(key, { id: "B-message", text: "B" }); });
  await act(async () => { reject(new Error("offline")); await sending; });
  expect(deps.composerRef.current?.setText).not.toHaveBeenCalled();
  expect(useThreadSendStore.getState().operations[key]).toMatchObject({ dispatching: true, pendingUserMessage: { text: "B" } });
  expect(useRelayStore.getState().activeSessionId).toBe(other.id);
});

it("the same text in an earlier turn does not suppress the new pending turn", () => {
  setup(true);
  const session = { id: "A", taskGoal: "repeat", createdAt: "2026-11-09", events: [] } as unknown as RelaySession;
  const key = threadSendKey("alice", session.id);
  useThreadSendStore.getState().beginSend(key, { id: "new-event", text: "repeat" });
  const t = ((key: string) => key) as TFunction;
  const { result, rerender } = renderHook(({ session }) => useThreadTranscript(session, [], t), { initialProps: { session } });
  expect(result.current.displayMessages.filter(m => m.kind === "user")).toHaveLength(2);
  rerender({ session: { ...session, events: [{ id: "new-event", type: "user.message", text: "repeat", timestamp: session.createdAt }] } as RelaySession });
  expect(result.current.pendingUserMessage).toBeNull();
  expect(result.current.displayMessages.filter(m => m.kind === "user")).toHaveLength(2);
});

it("Stop still cancels A after navigation and its response cannot reopen A", async () => {
  const { deps, accept, cancel, session } = setup(true);
  useRelayStore.getState().openSession(session.id);
  const { result } = renderHook(() => useThreadDispatch(deps));
  let sending!: Promise<boolean>;
  act(() => { sending = result.current.sendMessage(); });
  await act(async () => { await result.current.cancelActiveRun(); });
  act(() => useRelayStore.getState().openSession("B"));
  await act(async () => { accept(session); await sending; });
  expect(cancel).toHaveBeenCalledWith(expect.objectContaining({ sessionId: session.id }));
  expect(useRelayStore.getState().activeSessionId).toBe("B");
  expect(deps.syncThreadUrl).toHaveBeenCalledTimes(1);
});

it.each(["retry", "handoff"] as const)("late %s preserves the newly selected Thread", async (kind) => {
  const { deps, accept, dispatch, session } = setup(true);
  deps.effectiveSelectableLogicalAgents = deps.composerLogicalAgents!;
  deps.requestThreadRecoveryMutation = { mutateAsync: dispatch } as typeof deps.requestThreadRecoveryMutation;
  useRelayStore.getState().openSession(session.id);
  useHandoffStore.setState({ agentId: "agent-1", open: true, note: "original" });
  const { result } = renderHook(() => useThreadDispatch(deps));
  let sending!: Promise<void>;
  act(() => { sending = kind === "retry" ? result.current.retryAgentMessage("codex", "agent-1") : result.current.sendHandoff(); });
  act(() => { useRelayStore.getState().openSession("B"); useHandoffStore.setState({ note: "B draft" }); });
  await act(async () => { accept(session); await sending; });
  expect(useRelayStore.getState().activeSessionId).toBe("B");
  expect(useHandoffStore.getState().note).toBe("B draft");
  expect(deps.syncThreadUrl).not.toHaveBeenCalled();
});

it("browser navigation away and back invalidates late navigation effects", async () => {
  const { deps, accept, session } = setup(true);
  window.history.replaceState({}, "", "/threads/thread-1");
  useRelayStore.getState().openSession(session.id);
  const { result } = renderHook(() => useThreadDispatch(deps));
  let sending!: Promise<boolean>;
  act(() => { sending = result.current.sendMessage(); });
  act(() => {
    window.history.pushState({}, "", "/settings");
    window.dispatchEvent(new PopStateEvent("popstate"));
    window.history.replaceState({}, "", "/threads/thread-1");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await act(async () => { accept(session); await sending; });
  expect(deps.syncThreadUrl).toHaveBeenCalledTimes(1);
});

it("A completing during B's real send leaves B dispatching", async () => {
  const { deps, accept, session } = setup(true);
  let acceptB!: (session: RelaySession) => void;
  const responseB = new Promise<RelaySession>(resolve => { acceptB = resolve; });
  const other = { ...session, id: "B" };
  useRelayStore.getState().openSession(session.id);
  const { result, rerender } = renderHook((props) => useThreadDispatch(props), { initialProps: deps });
  let sendingA!: Promise<boolean>;
  let sendingB!: Promise<boolean>;
  act(() => { sendingA = result.current.sendMessage(); });
  act(() => useRelayStore.getState().openSession(other.id));
  rerender({ ...deps, activeSession: other, submitThreadMessageMutation: { mutateAsync: () => responseB } as typeof deps.submitThreadMessageMutation });
  act(() => { sendingB = result.current.sendMessage(); });
  await act(async () => { accept(session); await sendingA; });
  expect(useThreadSendStore.getState().operations[threadSendKey("alice", other.id)]?.dispatching).toBe(true);
  expect(useRelayStore.getState().activeSessionId).toBe(other.id);
  await act(async () => { acceptB(other); await sendingB; });
  expect(useThreadSendStore.getState().operations[threadSendKey("alice", other.id)]?.dispatching).toBe(false);
});

it("the first send from an empty list keeps one draft identity and rejects a duplicate submit", async () => {
  const { deps, accept, dispatch, session } = setup();
  useRelayStore.setState({ composingNew: false });
  deps.syncThreadUrl = (id) => useRelayStore.getState().setComposingNew(id === null);
  const { result } = renderHook(() => useThreadDispatch(deps));
  let first!: Promise<boolean>;
  act(() => { first = result.current.sendMessage(); });
  const key = threadSendKey("alice", undefined, useRelayStore.getState().threadDraftId);
  expect(useThreadSendStore.getState().operations[key]?.pendingUserMessage?.text).toBe("do work");
  let duplicate!: boolean;
  await act(async () => { duplicate = await result.current.sendMessage(); });
  expect(duplicate).toBe(false);
  expect(dispatch).toHaveBeenCalledTimes(1);
  await act(async () => { accept(session); await first; });
});


it.each([false, true])("restores a rejected send to A's draft after leaving (returnBeforeFailure=%s)", async (returnBeforeFailure) => {
  sessionStorage.clear();
  const { deps, reject, session } = setup(true);
  useRelayStore.getState().openSession(session.id);
  const other = { ...session, id: "B" };
  const hook = renderHook(({ activeSession }) => {
    const composer = useComposer(threadDraftKey({ username: "alice" }, activeSession.id));
    const composerRef = useRef<ComposerHandle | null>(null);
    composerRef.current = {
      getText: () => composer.composerText,
      setText: text => composer.setComposerText(text),
      clear: () => composer.setComposerText(""), focus: () => {}, send: async () => false,
    };
    return { composer, dispatch: useThreadDispatch({ ...deps, activeSession, composerRef }) };
  }, { initialProps: { activeSession: session } });
  act(() => hook.result.current.composer.setComposerText("keep this message"));
  let sending!: Promise<boolean>;
  act(() => { sending = hook.result.current.dispatch.sendMessage(); });
  act(() => useRelayStore.getState().openSession(other.id));
  hook.rerender({ activeSession: other });
  act(() => hook.result.current.composer.setComposerText("B's draft"));
  if (returnBeforeFailure) {
    act(() => useRelayStore.getState().openSession(session.id));
    hook.rerender({ activeSession: session });
    act(() => hook.result.current.composer.setComposerText("A's newer draft"));
  }
  await act(async () => { reject(new Error("offline")); await sending; });
  if (!returnBeforeFailure) {
    expect(hook.result.current.composer.composerText).toBe("B's draft");
    act(() => useRelayStore.getState().openSession(session.id));
    hook.rerender({ activeSession: session });
  }
  expect(hook.result.current.composer.composerText).toBe(returnBeforeFailure
    ? "keep this message\n\nA's newer draft"
    : "keep this message");
});
