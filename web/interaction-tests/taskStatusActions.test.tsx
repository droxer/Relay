import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { useTaskStatusActions } from "../src/hooks/useTaskStatusActions";

const mutateAsync = vi.hoisted(() => vi.fn());
vi.mock("../src/hooks/useRelayMutations", async () => {
  const { useMutation } = await import("@tanstack/react-query");
  const TASK_UPDATE_MUTATION_KEY = ["task-update"] as const;
  return {
    TASK_UPDATE_MUTATION_KEY,
    useRelayMutations: () => ({
      updateTaskMutation: useMutation({ mutationKey: TASK_UPDATE_MUTATION_KEY, mutationFn: (input) => mutateAsync(input) }),
    }),
  };
});
beforeEach(() => { mutateAsync.mockReset(); });

function open(client = new QueryClient()) {
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return renderHook(({ id }) => useTaskStatusActions(id), { initialProps: { id: "a" }, wrapper });
}

it("keeps unblock pending per Task and rejects a duplicate before the next render", async () => {
  const first = Promise.withResolvers<void>();
  const second = Promise.withResolvers<void>();
  mutateAsync.mockImplementation(({ taskId }) => taskId === "a" ? first.promise : second.promise);
  const hook = open();
  let unblockA!: Promise<boolean>;
  let duplicate!: Promise<boolean>;
  await act(async () => {
    unblockA = hook.result.current.unblock();
    duplicate = hook.result.current.unblock();
  });
  expect(mutateAsync).toHaveBeenCalledTimes(1);
  expect(await duplicate).toBe(false);
  expect(hook.result.current.busy).toBe("unblock");

  hook.rerender({ id: "b" });
  expect(hook.result.current.busy).toBeNull();
  let unblockB!: Promise<boolean>;
  await act(async () => { unblockB = hook.result.current.unblock(); });
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

it("keeps a pending Task action locked when the Thread view remounts", async () => {
  const client = new QueryClient();
  const receipt = Promise.withResolvers<void>();
  mutateAsync.mockReturnValue(receipt.promise);
  const original = open(client);
  let request!: Promise<boolean>;
  await act(async () => { request = original.result.current.unblock(); });
  original.unmount();

  const reopened = open(client);
  expect(reopened.result.current.busy).toBe("unblock");
  await act(async () => { expect(await reopened.result.current.unblock()).toBe(false); });
  expect(mutateAsync).toHaveBeenCalledOnce();
  await act(async () => {
    receipt.resolve();
    expect(await request).toBe(true);
  });
  expect(reopened.result.current.busy).toBeNull();
});
