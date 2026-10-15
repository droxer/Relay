import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { useSessionDetail } from "../src/hooks/useSessionDetail";
import { getSession } from "../src/api";

vi.mock("../src/api", () => ({ getSession: vi.fn() }));

const key = ["relay", "sessions"];
const session = (status: string) => ({ id: "live", status, events: [], agentRuns: [], artifacts: [] });

function setHidden(hidden: boolean) {
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
}

afterEach(() => { setHidden(false); });

it("skips reconciliation ticks in a hidden tab and catches up when shown", async () => {
  vi.useFakeTimers();
  const client = new QueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  client.setQueryData(key, [session("running")]);
  vi.mocked(getSession).mockResolvedValue(session("running") as never);
  const view = renderHook(() => useSessionDetail("live", true), { wrapper });
  await act(async () => {});
  expect(getSession).toHaveBeenCalledTimes(1);

  // A status change lands while the tab is hidden: no tick may fetch.
  setHidden(true);
  client.setQueryData(key, [session("completed")]);
  vi.mocked(getSession).mockResolvedValue(session("completed") as never);
  await act(() => vi.advanceTimersByTimeAsync(10_000));
  expect(getSession).toHaveBeenCalledTimes(1);

  setHidden(false);
  await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
  expect(getSession).toHaveBeenCalledTimes(2);
  view.unmount(); client.clear();
});
