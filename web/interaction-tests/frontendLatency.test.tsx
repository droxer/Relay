import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { expect, it, vi } from "vitest";
import { pickActiveThreadSession } from "../src/lib/threads";
import { useSessionDetail } from "../src/hooks/useSessionDetail";
import { getSession } from "../src/api";
import { setSessionStreamConnected } from "../src/lib/sessionStreamStatus";
vi.mock("../src/api", () => ({ getSession: vi.fn() }));
const key = ["relay", "sessions"];
const record = { id: "older", taskGoal: "Task", createdAt: "2026-01-01", updatedAt: "2026-01-01", status: "running", events: [], agentRuns: [], artifacts: [] };
function setup(id = "older") {
  vi.useFakeTimers();
  setSessionStreamConnected(false);
  Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
  const client = new QueryClient();
  client.setQueryData(key, [record]);
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const view = renderHook(() => useSessionDetail(id, true), { wrapper });
  return { client, view };
}
it("does not display a different conversation while a routed thread loads", () => {
  expect(pickActiveThreadSession({ threads: [record] as never, selectedSessionId: "older", activeSessionId: "older", composingNew: false, requestedSessionId: "outside-first-page" })).toBeUndefined();
});
it("hydrates a routed thread that the first list page does not contain", async () => {
  vi.mocked(getSession).mockReset().mockResolvedValue({ ...record, id: "outside-first-page" } as never);
  const { client, view } = setup("outside-first-page");
  await act(async () => {});
  expect(client.getQueryData<any[]>(key)?.some(s => s.id === "outside-first-page")).toBe(true);
  view.unmount(); client.clear();
});
it("reconciles a thread outside the polled page when its stream is unavailable", async () => {
  vi.mocked(getSession).mockReset().mockResolvedValue(record as never);
  const { client, view } = setup();
  await act(async () => {});
  vi.mocked(getSession).mockResolvedValue({ ...record, status: "completed" } as never);
  await act(() => vi.advanceTimersByTimeAsync(15_000));
  expect(client.getQueryData<any[]>(key)?.[0].status).toBe("completed");
  view.unmount(); client.clear();
});
it("backs off settled details but catches a reopened thread outside the head page", async () => {
  vi.mocked(getSession).mockReset().mockResolvedValue({ ...record, status: "completed" } as never);
  const { client, view } = setup();
  await act(async () => {});
  await act(() => vi.advanceTimersByTimeAsync(59_000));
  expect(getSession).toHaveBeenCalledTimes(1);
  vi.mocked(getSession).mockResolvedValue(record as never);
  await act(() => vi.advanceTimersByTimeAsync(1_000));
  expect(client.getQueryData<any[]>(key)?.[0].status).toBe("running");
  view.unmount(); client.clear();
});

it("does not refetch live details while SSE is connected", async () => {
  vi.mocked(getSession).mockReset().mockResolvedValue(record as never);
  const { client, view } = setup();
  setSessionStreamConnected(true);
  await act(async () => {});
  await act(() => vi.advanceTimersByTimeAsync(60_000));
  expect(getSession).toHaveBeenCalledTimes(1);
  view.unmount(); client.clear(); setSessionStreamConnected(false);
});

it("reports a missing thread, stops automatic retries, and allows an explicit retry", async () => {
  const missing = Object.assign(new Error("Thread not found"), { status: 404 });
  vi.mocked(getSession).mockReset().mockRejectedValue(missing);
  const { client, view } = setup("missing");
  await act(async () => {});
  expect(view.result.current.error).toBe("Thread not found");
  await act(() => vi.advanceTimersByTimeAsync(30_000));
  expect(getSession).toHaveBeenCalledTimes(1);
  vi.mocked(getSession).mockResolvedValue({ ...record, id: "missing" } as never);
  await act(async () => view.result.current.retry());
  expect(view.result.current.error).toBeNull();
  expect(client.getQueryData<any[]>(key)?.[0].id).toBe("missing");
  view.unmount(); client.clear();
});

it("leaves the directory unselected even with a remembered conversation", () => {
  expect(pickActiveThreadSession({ threads: [record] as never, selectedSessionId: "older", activeSessionId: "older", composingNew: false, listOnly: true })).toBeUndefined();
});

it("does not request detail until selected and reuses it when revisiting", async () => {
  vi.useFakeTimers();
  setSessionStreamConnected(false);
  vi.mocked(getSession).mockReset().mockResolvedValue(record as never);
  const client = new QueryClient();
  client.setQueryData(key, [record]);
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const view = renderHook(({ id }: { id?: string }) => useSessionDetail(id, true), { wrapper, initialProps: { id: undefined } });
  await act(async () => {});
  expect(getSession).not.toHaveBeenCalled();
  view.rerender({ id: "older" });
  await act(async () => {});
  expect(getSession).toHaveBeenCalledTimes(1);
  view.rerender({ id: undefined });
  view.rerender({ id: "older" });
  await act(async () => {});
  expect(getSession).toHaveBeenCalledTimes(1);
  view.unmount(); client.clear();
});

it("reuses browser storage after a reload, scoped to the signed-in account", async () => {
  vi.useFakeTimers();
  sessionStorage.clear();
  setSessionStreamConnected(false);
  vi.mocked(getSession).mockReset().mockResolvedValue(record as never);
  const mount = (owner: string) => {
    const client = new QueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    return { client, view: renderHook(() => useSessionDetail("older", true, owner), { wrapper }) };
  };
  const first = mount("alice");
  await act(async () => {});
  first.view.unmount(); first.client.clear();
  const reloaded = mount("alice");
  await act(async () => {});
  expect(getSession).toHaveBeenCalledTimes(1);
  expect(reloaded.client.getQueryData<any[]>(key)?.[0].id).toBe("older");
  reloaded.view.unmount(); reloaded.client.clear();
  const other = mount("bob");
  await act(async () => {});
  expect(getSession).toHaveBeenCalledTimes(2);
  other.view.unmount(); other.client.clear();
  sessionStorage.clear();
});

it("reconciles stale browser details and newer summary observations", async () => {
  vi.useFakeTimers();
  sessionStorage.clear();
  setSessionStreamConnected(false);
  vi.mocked(getSession).mockReset().mockResolvedValue(record as never);
  const client = new QueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const view = renderHook(({ id }: { id?: string }) => useSessionDetail(id, true, "alice"), { wrapper, initialProps: { id: "older" } });
  await act(async () => {});
  view.rerender({ id: undefined });
  await act(() => vi.advanceTimersByTimeAsync(16_000));
  view.rerender({ id: "older" });
  await act(async () => {});
  expect(getSession).toHaveBeenCalledTimes(2);
  view.rerender({ id: undefined });
  client.setQueryData(key, [{ ...record, summaryEventCount: 1 }]);
  view.rerender({ id: "older" });
  await act(async () => {});
  expect(getSession).toHaveBeenCalledTimes(3);
  view.unmount(); client.clear(); sessionStorage.clear();
});

it("keeps the stream gated until the initial snapshot is hydrated", async () => {
  const client = new QueryClient();
  let resolve!: (value: never) => void;
  vi.mocked(getSession).mockReset().mockReturnValue(new Promise(done => { resolve = done; }));
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const view = renderHook(() => useSessionDetail("older", true), { wrapper });
  expect(view.result.current.ready).toBe(false);
  await act(async () => { resolve(record as never); });
  expect(view.result.current.ready).toBe(true);
  view.unmount(); client.clear();
});


it("evicts persisted details after access is revoked", async () => {
  sessionStorage.clear();
  const { readSessionDetails } = await import("../src/lib/sessionDetailCache");
  const client = new QueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  vi.mocked(getSession).mockReset().mockResolvedValue(record as never);
  const view = renderHook(() => useSessionDetail("older", true, "alice"), { wrapper });
  await act(async () => {});
  expect(readSessionDetails("alice")).toHaveLength(1);
  vi.mocked(getSession).mockRejectedValue(Object.assign(new Error("Forbidden"), { status: 403 }));
  await act(async () => { view.result.current.retry(); });
  expect(view.result.current.ready).toBe(false);
  expect(readSessionDetails("alice")).toEqual([]);
  view.unmount(); client.clear(); sessionStorage.clear();
});
