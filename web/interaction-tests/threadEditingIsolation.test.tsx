import { act, renderHook } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { TFunction } from "i18next";
import { useThreadEditing } from "../src/hooks/useThreadEditing";
import { useRelayStore } from "../src/lib/store";
import type { RelaySession } from "../src/types";

const mocks = vi.hoisted(() => ({ remove: vi.fn(), confirm: vi.fn() }));
vi.mock("../src/hooks/useRelayMutations", () => ({
  useRelayMutations: () => ({ deleteSessionMutation: { mutateAsync: mocks.remove } }),
}));
vi.mock("../src/components/ui/DialogProvider", () => ({
  useDialogs: () => ({ confirm: mocks.confirm }),
}));

it.each([false, true])("deleting A respects later navigation (leave=%s)", async (leave) => {
  useRelayStore.setState({ ...useRelayStore.getInitialState(), selectedUser: "alice" }, true);
  useRelayStore.getState().openSession("A");
  let resolve!: (pending: null) => void;
  mocks.confirm.mockResolvedValue(true);
  mocks.remove.mockReturnValue(new Promise<null>(done => { resolve = done; }));
  const onActiveThreadDeleted = vi.fn(() => useRelayStore.getState().clearSelection());
  const props = {
    threads: [{ id: "A", taskGoal: "A" }] as RelaySession[], activeSessionId: "A",
    token: undefined, t: ((key: string) => key) as TFunction, onActiveThreadDeleted,
  };
  const hook = renderHook(input => useThreadEditing(input), { initialProps: props });
  let deleting!: Promise<void>;
  await act(async () => { deleting = hook.result.current.deleteThread("A"); });
  if (leave) {
    act(() => useRelayStore.getState().openSession("B"));
    hook.rerender({ ...props, activeSessionId: "B" });
  }
  await act(async () => { resolve(null); await deleting; });
  expect(onActiveThreadDeleted).toHaveBeenCalledTimes(leave ? 0 : 1);
  expect(useRelayStore.getState().activeSessionId).toBe(leave ? "B" : null);
});
