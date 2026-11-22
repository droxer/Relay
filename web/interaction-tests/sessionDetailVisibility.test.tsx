import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { useSessionDetail } from "../src/hooks/useSessionDetail";
import { getSession } from "../src/api";
import { readOlderTranscript } from "../src/api-client/sessions";
import { RELAY_POLL_INTERVALS_MS } from "../src/lib/relayPolling";
import { fetchSessionSnapshot } from "../src/lib/sessionSnapshotQuery";
import type { RelaySession } from "../src/types";

vi.mock("../src/api", () => ({ getSession: vi.fn() }));
vi.mock("../src/api-client/sessions", () => ({ readOlderTranscript: vi.fn() }));

const key = ["relay", "sessions"];
const session = (status: string) => ({ id: "live", status, events: [], agentRuns: [], artifacts: [] });
const event = (id: string): RelaySession["events"][number] => ({
  id, type: "user.message", sessionId: "live", timestamp: "2026-01-01", text: id,
});
const completed = (eventStart: number, ...events: RelaySession["events"]) =>
  ({ ...session("completed"), eventStart, events } as RelaySession);

function setup() {
  const client = new QueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return { client, wrapper, cached: () => client.getQueryData<RelaySession[]>(key)?.[0] };
}

function setHidden(hidden: boolean) {
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
}

afterEach(() => { setHidden(false); });

it("skips reconciliation ticks in a hidden tab and catches up when shown", async () => {
  vi.useFakeTimers();
  const { client, wrapper } = setup();
  vi.mocked(getSession).mockReset();
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

it("retries a shared snapshot behind the summary on the next tick", async () => {
  vi.useFakeTimers();
  const { client, wrapper, cached } = setup();
  let finish!: (snapshot: RelaySession) => void;
  vi.mocked(getSession).mockReset()
    .mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
    .mockResolvedValue(completed(0, event("old"), event("latest")));
  const oldRead = fetchSessionSnapshot(client, "live");
  client.setQueryData(key, [{ ...completed(0), summaryEventCount: 2 }]);
  const view = renderHook(() => useSessionDetail("live", true), { wrapper });
  expect(getSession).toHaveBeenCalledTimes(1);
  await act(async () => {
    finish(completed(0, event("old")));
    await oldRead;
  });
  expect(view.result.current).toMatchObject({ ready: false, error: null });
  expect(cached()?.events).toEqual([]);

  await act(() => vi.advanceTimersByTimeAsync(RELAY_POLL_INTERVALS_MS.sessions));
  expect(getSession).toHaveBeenCalledTimes(2);
  expect(view.result.current.ready).toBe(true);
  expect(cached()?.events.map(item => item.id)).toEqual(["old", "latest"]);
  view.unmount(); client.clear();
});

it("keeps loaded messages during a failed gap read and stitches the gap on retry", async () => {
  vi.useFakeTimers();
  const { client, wrapper, cached } = setup();
  const first = event("first loaded");
  const last = event("last loaded");
  const latest = event("latest");
  client.setQueryData(key, [completed(5, first, last)]);
  vi.mocked(getSession).mockReset().mockResolvedValue(completed(9, latest));
  const older = vi.mocked(readOlderTranscript).mockReset()
    .mockResolvedValueOnce({ eventStart: 8, eventCount: 9, events: [event("gap two")] })
    .mockRejectedValueOnce(new Error("Temporarily unavailable"))
    .mockResolvedValueOnce({ eventStart: 6, eventCount: 8, events: [last, event("gap one")] });
  const view = renderHook(() => useSessionDetail("live", true), { wrapper });
  await act(async () => {});
  expect(cached()).toMatchObject({ eventStart: 5, events: [first, last] });
  expect(older.mock.calls.map(([, before]) => before)).toEqual([9, 8]);

  await act(() => vi.advanceTimersByTimeAsync(RELAY_POLL_INTERVALS_MS.sessions));
  expect(older.mock.calls.map(([, before]) => before)).toEqual([9, 8, 8]);
  expect(cached()?.eventStart).toBe(5);
  expect(cached()?.events.map(item => item.id)).toEqual([
    "first loaded", "last loaded", "gap one", "gap two", "latest",
  ]);
  expect(view.result.current).toMatchObject({ ready: true, error: null });
  view.unmount(); client.clear();
});
