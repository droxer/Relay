import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { expect, it, vi } from "vitest";
import { useTaskRecord } from "../src/hooks/useTaskRecord";
import { getTask } from "../src/api";
import { RELAY_POLL_INTERVALS_MS } from "../src/lib/relayPolling";

vi.mock("../src/api", () => ({ getTask: vi.fn(), RelayApiError: class extends Error {} }));

const task = (status: string, updatedAt = "2026-10-01T00:00:00.000Z") =>
  ({ id: "t1", title: "Task", status, updatedAt }) as never;

function setup(initial: unknown, dependentIds?: readonly string[], compactList = false) {
  vi.useFakeTimers();
  const client = new QueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const view = renderHook(({ row, dependents }) => useTaskRecord("t1", row as never, dependents, compactList), {
    wrapper, initialProps: { row: initial, dependents: dependentIds },
  });
  return { client, view };
}

it("reuses the Task record when the late Issues page confirms its revision and dependencies", async () => {
  const row = { ...task("done") as object, eventCount: 3, waitingOn: [] };
  vi.mocked(getTask).mockReset().mockResolvedValue({ ...row, unblocks: [] } as never);
  const { client, view } = setup(undefined, [], true);
  try {
    await act(async () => {});
    await act(() => vi.advanceTimersByTimeAsync(1));
    await act(async () => view.rerender({ row, dependents: [] }));
    expect(getTask).toHaveBeenCalledTimes(1);

    const waiting = { ...row, waitingOn: ["prerequisite"] };
    vi.mocked(getTask).mockResolvedValue({ ...waiting, unblocks: [] } as never);
    await act(async () => view.rerender({ row: waiting, dependents: [] }));
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(getTask).toHaveBeenCalledTimes(2);

    vi.mocked(getTask).mockResolvedValue({ ...waiting, unblocks: ["dependent"] } as never);
    await act(async () => view.rerender({ row: waiting, dependents: ["dependent"] }));
    expect(getTask).toHaveBeenCalledTimes(3);
  } finally {
    view.unmount();
    client.clear();
    vi.useRealTimers();
  }
});

it("polls a record outside the list, then backs off once it settles", async () => {
  vi.mocked(getTask).mockReset().mockResolvedValue(task("running"));
  const { client, view } = setup(undefined);
  await act(async () => {});
  expect(getTask).toHaveBeenCalledTimes(1);
  expect(getTask).toHaveBeenLastCalledWith("t1", expect.any(AbortSignal), "record", expect.any(Object));
  await act(() => vi.advanceTimersByTimeAsync(RELAY_POLL_INTERVALS_MS.tasks));
  expect(getTask).toHaveBeenCalledTimes(2);

  vi.mocked(getTask).mockResolvedValue(task("done"));
  await act(() => vi.advanceTimersByTimeAsync(RELAY_POLL_INTERVALS_MS.tasks));
  expect(getTask).toHaveBeenCalledTimes(3);
  await act(() => vi.advanceTimersByTimeAsync(RELAY_POLL_INTERVALS_MS.settledTaskRecord - 1));
  expect(getTask).toHaveBeenCalledTimes(3);
  await act(() => vi.advanceTimersByTimeAsync(1));
  expect(getTask).toHaveBeenCalledTimes(4);
  view.unmount(); client.clear(); vi.useRealTimers();
});

it("uses the list's event count as the change signal for a live Task record", async () => {
  vi.mocked(getTask).mockReset().mockResolvedValue(task("running"));
  const first = { ...task("running") as object, eventCount: 3 };
  const { client, view } = setup(first);
  await act(async () => {});
  await act(() => vi.advanceTimersByTimeAsync(RELAY_POLL_INTERVALS_MS.tasks * 3));
  expect(getTask).toHaveBeenCalledTimes(1);
  view.rerender({ row: { ...first, eventCount: 4 } });
  await act(async () => {});
  expect(getTask).toHaveBeenCalledTimes(2);
  view.rerender({ row: { ...first, eventCount: 4, waitingOn: ["another-task"] } });
  await act(async () => {});
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
