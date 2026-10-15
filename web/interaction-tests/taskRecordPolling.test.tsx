import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { expect, it, vi } from "vitest";
import { useTaskRecord } from "../src/hooks/useTaskRecord";
import { getTask } from "../src/api";

vi.mock("../src/api", () => ({ getTask: vi.fn(), RelayApiError: class extends Error {} }));

const task = (status: string, updatedAt = "2026-10-01T00:00:00.000Z") =>
  ({ id: "t1", title: "Task", status, updatedAt }) as never;

function setup(initial: unknown) {
  vi.useFakeTimers();
  const client = new QueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const view = renderHook(({ row }) => useTaskRecord("t1", row as never), { wrapper, initialProps: { row: initial } });
  return { client, view };
}

it("polls a live record and stops once it settles", async () => {
  vi.mocked(getTask).mockReset().mockResolvedValue(task("running"));
  const { client, view } = setup(task("running"));
  await act(async () => {});
  expect(getTask).toHaveBeenCalledTimes(1);
  await act(() => vi.advanceTimersByTimeAsync(3_000));
  expect(getTask).toHaveBeenCalledTimes(2);

  vi.mocked(getTask).mockResolvedValue(task("done"));
  await act(() => vi.advanceTimersByTimeAsync(3_000));
  expect(getTask).toHaveBeenCalledTimes(3);
  await act(() => vi.advanceTimersByTimeAsync(30_000));
  expect(getTask).toHaveBeenCalledTimes(3);
  view.unmount(); client.clear(); vi.useRealTimers();
});

it("refetches a settled record when its list row changes", async () => {
  vi.mocked(getTask).mockReset().mockResolvedValue(task("done"));
  const { client, view } = setup(task("done"));
  await act(async () => {});
  expect(getTask).toHaveBeenCalledTimes(1);
  view.rerender({ row: task("done") });
  await act(() => vi.advanceTimersByTimeAsync(10_000));
  expect(getTask).toHaveBeenCalledTimes(1);

  vi.mocked(getTask).mockResolvedValue(task("assigned", "2026-10-02T00:00:00.000Z"));
  view.rerender({ row: task("assigned", "2026-10-02T00:00:00.000Z") });
  await act(async () => {});
  expect(getTask).toHaveBeenCalledTimes(2);
  await act(() => vi.advanceTimersByTimeAsync(0));
  expect((view.result.current.task as { status?: string })?.status).toBe("assigned");
  view.unmount(); client.clear(); vi.useRealTimers();
});
