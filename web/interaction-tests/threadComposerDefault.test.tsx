import { act, renderHook } from "@testing-library/react";
import { beforeEach, expect, it } from "vitest";
import { useThreadComposerSelection } from "../src/hooks/useThreadComposerSelection";
import { useComposerTargetStore } from "../src/lib/composerTargetStore";

const taskAgent = { id: "agt_task", executorKind: "codex" as const };
type Props = Parameters<typeof useThreadComposerSelection>[0];
const base: Props = { sessionId: "ses_task", composingNew: false, targetsReady: true, teamIds: [], threadAgent: taskAgent };
const target = () => useComposerTargetStore.getState().activeLogicalAgentId;

beforeEach(() => {
  useComposerTargetStore.setState({ ...useComposerTargetStore.getInitialState(), threadPicks: {} }, true);
  useComposerTargetStore.getState().pickAgent({ id: "agt_last_used", executorKind: "claude" });
});

it("opens a task's thread on the task's agent, not the last one picked elsewhere", () => {
  renderHook((props: Props) => useThreadComposerSelection(props), { initialProps: base });
  expect(target()).toBe("agt_task");
});

it("waits for the roster, then defaults once and keeps the person's next pick", () => {
  const { rerender } = renderHook((props: Props) => useThreadComposerSelection(props), {
    initialProps: { ...base, threadAgent: null },
  });
  expect(target()).toBe("agt_last_used");
  rerender(base);
  expect(target()).toBe("agt_task");

  act(() => useComposerTargetStore.getState().pickAgent({ id: "agt_other", executorKind: "pi" }));
  rerender({ ...base, threadAgent: { ...taskAgent } });
  expect(target()).toBe("agt_other");
});

it("re-applies the task's agent after staging a new thread and coming back", () => {
  const { rerender } = renderHook((props: Props) => useThreadComposerSelection(props), { initialProps: base });
  act(() => useComposerTargetStore.getState().pickAgent({ id: "agt_other", executorKind: "pi" }));
  rerender({ ...base, composingNew: true });
  rerender(base);
  expect(target()).toBe("agt_task");
});

it("keeps a pick the person saved for that thread", () => {
  useComposerTargetStore.getState().pickAgent({ id: "agt_saved", executorKind: "pi" });
  useComposerTargetStore.getState().rememberThreadPick("ses_task");
  useComposerTargetStore.getState().pickAgent({ id: "agt_last_used", executorKind: "claude" });
  renderHook((props: Props) => useThreadComposerSelection(props), { initialProps: base });
  expect(target()).toBe("agt_saved");
});

it("narrows a project thread from the crew to the task's agent", () => {
  useComposerTargetStore.getState().pickRoom();
  renderHook((props: Props) => useThreadComposerSelection(props), { initialProps: base });
  expect(useComposerTargetStore.getState().projectRoomTarget).toBe(false);
  expect(target()).toBe("agt_task");
});

it("keeps the crew when the person picked it for that thread", () => {
  useComposerTargetStore.getState().pickRoom();
  useComposerTargetStore.getState().rememberThreadPick("ses_task", { kind: "room" });
  renderHook((props: Props) => useThreadComposerSelection(props), { initialProps: base });
  expect(useComposerTargetStore.getState().projectRoomTarget).toBe(true);
});
