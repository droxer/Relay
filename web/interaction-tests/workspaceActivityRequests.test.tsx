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
    expect(requests.mock.calls.map(([path]) => path)).toEqual(["/api/v1/workspace/brief?teamId=team&view=activity"]);
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
