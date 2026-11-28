import { act, renderHook } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { useTaskStatusActions } from "../src/hooks/useTaskStatusActions";

const mutateAsync = vi.hoisted(() => vi.fn());
vi.mock("../src/hooks/useRelayMutations", () => ({
  useRelayMutations: () => ({ updateTaskMutation: { mutateAsync } }),
}));

it("keeps unblock pending per Task and rejects a duplicate before the next render", async () => {
  const first = Promise.withResolvers<void>();
  const second = Promise.withResolvers<void>();
  mutateAsync.mockImplementation(({ taskId }) => taskId === "a" ? first.promise : second.promise);
  const hook = renderHook(({ id }) => useTaskStatusActions(id), { initialProps: { id: "a" } });
  let unblockA!: Promise<boolean>;
  let duplicate!: Promise<boolean>;
  act(() => {
    unblockA = hook.result.current.unblock();
    duplicate = hook.result.current.unblock();
  });
  expect(mutateAsync).toHaveBeenCalledTimes(1);
  expect(await duplicate).toBe(false);
  expect(hook.result.current.busy).toBe("unblock");

  hook.rerender({ id: "b" });
  expect(hook.result.current.busy).toBeNull();
  let unblockB!: Promise<boolean>;
  act(() => { unblockB = hook.result.current.unblock(); });
  expect(mutateAsync).toHaveBeenLastCalledWith({ taskId: "b", input: { action: "unblock" } });

  hook.rerender({ id: "a" });
  expect(hook.result.current.busy).toBe("unblock");
  hook.rerender({ id: "b" });
  await act(async () => {
    first.resolve();
    expect(await unblockA).toBe(true);
  });
  expect(hook.result.current.busy).toBe("unblock");
  await act(async () => {
    second.reject(new Error("Could not unblock"));
    expect(await unblockB).toBe(false);
  });
  expect(hook.result.current.busy).toBeNull();
});
