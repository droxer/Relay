import { QueryClient, QueryClientProvider, focusManager } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { expect, it, vi } from "vitest";
import { useWorkspaceActivity } from "../src/hooks/useWorkspaceActivity";

it("reuses settled Activity reads and polls more frequently once a run appears", async () => {
  vi.useFakeTimers();
  focusManager.setFocused(true);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  let running = false;
  const requests = vi.fn(async (_path: string) => Response.json({
    sessions: [], tasks: [],
    activeRuns: running ? [{ runId: "run", sessionId: "thread", agent: "codex" }] : [],
  }));
  vi.stubGlobal("fetch", requests);
  const view = renderHook(({ open }) => useWorkspaceActivity({ teamId: "team" }, open), {
    wrapper,
    initialProps: { open: false },
  });
  try {
    await act(async () => {});
    expect(requests).not.toHaveBeenCalled();
    view.rerender({ open: true });
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(requests.mock.calls.map(([path]) => path)).toEqual(["/api/v1/workspace/brief?teamId=team&view=activity&threadLimit=20"]);
    view.rerender({ open: false });
    view.rerender({ open: true });
    await act(() => vi.advanceTimersByTimeAsync(14_999));
    running = true;
    expect(requests).toHaveBeenCalledTimes(1);
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(requests).toHaveBeenCalledTimes(2);
    await act(() => vi.advanceTimersByTimeAsync(3_000));
    expect(requests).toHaveBeenCalledTimes(3);
  } finally {
    view.unmount();
    client.clear();
    focusManager.setFocused(undefined);
  }
});

it("loads older Threads on demand and polls only the conditional head", async () => {
  vi.useFakeTimers();
  focusManager.setFocused(true);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const thread = (id: string, day: number) => ({ id, title: id, updatedAt: `2026-11-${day}T00:00:00.000Z` });
  const requests = vi.fn(async (path: string) => {
    if (path.includes("threadCursor=")) {
      return Response.json({ sessions: [thread("old", 19)], nextThreadCursor: null });
    }
    if (new URL(path, "https://relay.test").searchParams.has("relayRevision")) {
      return new Response(null, { status: 304 });
    }
    return Response.json({
      sessions: [thread("new", 20)], activeRuns: [], tasks: [], nextThreadCursor: "older",
    }, { headers: { etag: 'W/"activity-head"' } });
  });
  vi.stubGlobal("fetch", requests);
  const view = renderHook(() => useWorkspaceActivity({ teamId: "team" }, true), { wrapper });
  try {
    await act(() => vi.advanceTimersByTimeAsync(2));
    expect(view.result.current.data?.sessions.map(row => row.id)).toEqual(["new"]);
    expect(requests).toHaveBeenCalledTimes(1);
    await act(async () => { await view.result.current.loadOlder(); });
    await act(() => vi.advanceTimersByTimeAsync(2));
    expect(view.result.current.data?.sessions.map(row => row.id)).toEqual(["new", "old"]);
    expect(view.result.current.hasOlder).toBe(false);

    await act(() => vi.advanceTimersByTimeAsync(15_000));
    expect(requests.mock.calls.map(([path]) => new URL(path, "https://relay.test").searchParams.get("threadCursor")))
      .toEqual([null, "older", null]);
    expect(new URL(requests.mock.calls[2][0], "https://relay.test").searchParams.get("relayRevision")).toBe('W/"activity-head"');
    expect(view.result.current.data?.sessions.map(row => row.id)).toEqual(["new", "old"]);
  } finally {
    view.unmount();
    client.clear();
    focusManager.setFocused(undefined);
  }
});
