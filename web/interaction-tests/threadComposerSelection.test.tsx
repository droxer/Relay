import { act, renderHook } from "@testing-library/react";
import { beforeEach, expect, it } from "vitest";
import { useThreadComposerSelection } from "../src/hooks/useThreadComposerSelection";
import { useComposerTargetStore } from "../src/lib/composerTargetStore";

beforeEach(() => {
  useComposerTargetStore.setState(useComposerTargetStore.getInitialState(), true);
});

it("restores the saved agent when the default thread arrives after loading", () => {
  const store = useComposerTargetStore.getState();
  store.rememberThreadPick("thread", { kind: "agent", agent: { id: "reviewer", executorKind: "codex" } });
  const { rerender } = renderHook(({ sessionId }) => useThreadComposerSelection({
    sessionId, composingNew: false, targetsReady: false, teamIds: [],
  }), { initialProps: { sessionId: undefined as string | undefined } });
  rerender({ sessionId: "thread" });
  expect(useComposerTargetStore.getState()).toMatchObject({
    projectRoomTarget: false, activeLogicalAgentId: "reviewer", activeAgent: "codex",
  });
});

it("keeps the restored team until its roster finishes loading", () => {
  useComposerTargetStore.getState().rememberThreadPick("thread", { kind: "team", teamId: "team" });
  const { rerender } = renderHook((props) => useThreadComposerSelection(props), {
    initialProps: { sessionId: "thread", composingNew: false, targetsReady: false, teamIds: [] as string[] },
  });
  expect(useComposerTargetStore.getState().pendingThreadTeamId).toBe("team");
  rerender({ sessionId: "thread", composingNew: false, targetsReady: true, teamIds: ["team"] });
  expect(useComposerTargetStore.getState().pendingThreadTeamId).toBe("team");
});

it("drops a team only after loaded data confirms it is no longer available", () => {
  useComposerTargetStore.getState().rememberThreadPick("thread", { kind: "team", teamId: "removed" });
  const { rerender } = renderHook((props) => useThreadComposerSelection(props), {
    initialProps: { sessionId: "thread", composingNew: false, targetsReady: false, teamIds: [] as string[] },
  });
  expect(useComposerTargetStore.getState().pendingThreadTeamId).toBe("removed");
  rerender({ sessionId: "thread", composingNew: false, targetsReady: true, teamIds: [] });
  expect(useComposerTargetStore.getState().pendingThreadTeamId).toBeNull();
});

it("does not overwrite a new pick on roster updates and restores when returning to a thread", () => {
  const store = useComposerTargetStore.getState();
  store.rememberThreadPick("thread", { kind: "agent", agent: { id: "old", executorKind: "claude" } });
  const { rerender } = renderHook((props) => useThreadComposerSelection(props), {
    initialProps: { sessionId: "thread", composingNew: false, targetsReady: true, teamIds: [] as string[] },
  });
  act(() => {
    store.pickAgent({ id: "new", executorKind: "codex" });
    store.rememberThreadPick("thread");
  });
  rerender({ sessionId: "thread", composingNew: false, targetsReady: true, teamIds: ["team"] });
  expect(useComposerTargetStore.getState().activeLogicalAgentId).toBe("new");
  rerender({ sessionId: "other", composingNew: false, targetsReady: true, teamIds: [] });
  expect(useComposerTargetStore.getState().projectRoomTarget).toBe(true);
  rerender({ sessionId: "thread", composingNew: false, targetsReady: true, teamIds: [] });
  expect(useComposerTargetStore.getState().activeLogicalAgentId).toBe("new");
});

it("preserves a staged agent while composing a new thread", () => {
  const store = useComposerTargetStore.getState();
  store.rememberThreadPick("previous", { kind: "room" });
  store.pickAgent({ id: "draft-agent", executorKind: "codex" });
  renderHook(() => useThreadComposerSelection({
    sessionId: "previous", composingNew: true, targetsReady: false, teamIds: [],
  }));
  expect(useComposerTargetStore.getState()).toMatchObject({ projectRoomTarget: false, activeLogicalAgentId: "draft-agent" });
});

it("waits for the linked session before validating a deep-linked team", () => {
  const store = useComposerTargetStore.getState();
  store.rememberThreadPick("thread", { kind: "team", teamId: "team" });
  store.restoreThreadPick("thread");
  const { rerender } = renderHook((props) => useThreadComposerSelection(props), {
    initialProps: { sessionId: undefined as string | undefined, composingNew: false, targetsReady: true, teamIds: [] as string[] },
  });
  expect(useComposerTargetStore.getState().pendingThreadTeamId).toBe("team");
  rerender({ sessionId: "thread", composingNew: false, targetsReady: true, teamIds: ["team"] });
  expect(useComposerTargetStore.getState().pendingThreadTeamId).toBe("team");
});
