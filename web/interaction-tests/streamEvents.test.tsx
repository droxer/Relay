import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { RelaySession } from "../src/types";
import { afterEach, expect, it, vi } from "vitest";
import { useSessionEvents } from "../src/hooks/useSessionEvents";
import { getSession, RelayApiError } from "../src/api";
import { isSessionStreamConnected } from "../src/lib/sessionStreamStatus";
import { isThreadRunInFlight } from "../src/lib/threadRunning";
vi.mock("../src/api", () => ({ getSession: vi.fn(), RelayApiError: class extends Error { constructor(message: string, public status: number) { super(message); } } }));
const { deferFrame } = vi.hoisted(() => ({ deferFrame: { current: false } }));
vi.mock("../src/lib/frameScheduler", () => ({
  browserFrameSchedulerHost: () => ({}),
  createFrameScheduler: () => {
    let handle: ReturnType<typeof setTimeout> | undefined;
    return {
      request: (callback: () => void) => {
        if (!deferFrame.current) callback();
        else handle ??= setTimeout(callback, 16);
      },
      cancel: () => clearTimeout(handle),
    };
  },
}));
const key = ["relay", "sessions"];
const initial = { id: "live", status: "running", events: [], agentRuns: [], artifacts: [] };
class Source {
  static CLOSED = 2;
  readyState = 1;
  close = vi.fn();
  onmessage!: (event: { data: string }) => void;
  onerror!: () => void;
  onopen!: () => void;
  listeners = new Map<string, (event: { data: string }) => void>();
  addEventListener(type: string, listener: (event: { data: string }) => void) { this.listeners.set(type, listener); }
  constructor(public url: string) { sources.push(this); }
}
let sources: Source[] = [];
function setup(enabled = true) {
  vi.useFakeTimers(); sources = []; vi.stubGlobal("EventSource", Source);
  const client = new QueryClient();
  client.setQueryData(key, [initial]);
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const view = renderHook(({ id }) => useSessionEvents(id, enabled), { wrapper, initialProps: { id: "live" } });
  return { client, view };
}
afterEach(() => { deferFrame.current = false; vi.useRealTimers(); vi.unstubAllGlobals(); });

it("refreshes authoritative execution immediately after a terminal event, even after the stream unmounts", async () => {
  const { client, view } = setup();
  const event = { id: "end", type: "session.completed", sessionId: "live", timestamp: "2026-09-09T00:00:00Z", outcome: "done" };
  const running = { ...initial, execution: { phase: "running" } };
  const settled = { ...running, status: "completed", phase: "completed", execution: { phase: "terminal" }, events: [event] };
  client.setQueryData(key, [running]);
  let resolve!: (session: RelaySession) => void;
  vi.mocked(getSession).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  act(() => sources[0].onmessage({ data: JSON.stringify(event) }));
  expect(getSession).toHaveBeenCalled();
  view.unmount();
  await act(async () => resolve(settled as RelaySession));
  const session = client.getQueryData<RelaySession[]>(key)![0];
  expect(session.execution?.phase).toBe("terminal");
  expect(isThreadRunInFlight({ session, activeRun: undefined, pendingSend: false, dispatchingRun: false })).toBe(false);
  client.clear();
});

it("does not refresh execution when only an agent completes", () => {
  const { client, view } = setup();
  vi.mocked(getSession).mockClear();
  act(() => sources[0].onmessage({ data: JSON.stringify({
    id: "agent-end", type: "agent.completed", sessionId: "live", timestamp: "2026-09-09T00:00:00Z", runId: "run", status: "completed",
  }) }));
  expect(getSession).not.toHaveBeenCalled();
  view.unmount(); client.clear();
});

it.each(["completed", "failed", "cancelled"] as const)("revalidates linked Task state when a streamed round %s", async (status) => {
  const { client, view } = setup();
  const taskKey = ["task-record", "task"];
  const taskContextKey = ["relay", "tasks", "thread", "live"];
  client.setQueryData(taskKey, { id: "task", status: "running", linkedSessionIds: ["live"], sourceRoutineId: "automation" });
  client.setQueryData(taskContextKey, { tasks: [] });
  client.setQueryData(["task-runs", "automation", 25], { runs: [] });
  const event = { id: "end", type: "session.status", sessionId: "live", timestamp: "2026-09-09T00:00:00Z", status, phase: status };
  vi.mocked(getSession).mockResolvedValueOnce({ ...initial, status, execution: { phase: "terminal" }, events: [event] } as RelaySession);
  await act(async () => sources[0].onmessage({ data: JSON.stringify(event) }));
  expect(client.getQueryState(taskKey)?.isInvalidated).toBe(true);
  expect(client.getQueryState(taskContextKey)?.isInvalidated).toBe(true);
  expect(client.getQueryState(["task-runs", "automation", 25])?.isInvalidated).toBe(true);
  view.unmount(); client.clear();
});

it("retries when an in-flight snapshot predates the terminal event", async () => {
  const { client, view } = setup();
  const event = { id: "end", type: "session.completed", sessionId: "live", timestamp: "2026-09-09T00:00:00Z", outcome: "done" };
  let resolve!: (session: RelaySession) => void;
  vi.mocked(getSession).mockReset().mockImplementationOnce(() => new Promise(done => { resolve = done; }))
    .mockResolvedValueOnce({ ...initial, status: "completed", execution: { phase: "terminal" }, events: [event] } as RelaySession);
  const { fetchSessionSnapshot } = await import("../src/lib/sessionSnapshotQuery");
  const earlier = fetchSessionSnapshot(client, "live");
  act(() => sources[0].onmessage({ data: JSON.stringify(event) }));
  await act(async () => { resolve(initial as RelaySession); await earlier; });
  expect(getSession).toHaveBeenCalledTimes(2);
  expect(client.getQueryData<RelaySession[]>(key)?.[0].execution?.phase).toBe("terminal");
  view.unmount(); client.clear();
});

it("merges frames and batches once, tolerates malformed frames, and closes terminal streams", () => {
  const { client, view } = setup();
  const event = { id: "e1", type: "session.status", sessionId: "live", status: "waiting_for_human", phase: "feedback", timestamp: "2026-09-09T00:00:00Z" };
  act(() => {
    sources[0].onopen();
    sources[0].onmessage({ data: "" });
    sources[0].onmessage({ data: "{" });
    sources[0].listeners.get("batch")!({ data: "{" });
    sources[0].listeners.get("batch")!({ data: "" });
    sources[0].listeners.get("batch")!({ data: JSON.stringify({ events: [event, event, {}] }) });
    sources[0].onmessage({ data: JSON.stringify(event) });
  });
  expect(client.getQueryData<any[]>(key)?.[0].events).toHaveLength(1);
  act(() => sources[0].listeners.get("done")!({ data: JSON.stringify({ status: "running" }) }));
  expect(sources[0].close).not.toHaveBeenCalled();
  act(() => sources[0].listeners.get("done")!({ data: JSON.stringify({ status: "completed" }) }));
  expect(sources[0].close).toHaveBeenCalled();
  act(() => sources[0].listeners.get("done")!({ data: "{" }));
  view.unmount(); client.clear();
});

it("does not reconnect revoked access and does not open disabled streams", async () => {
  const { client, view } = setup();
  vi.mocked(getSession).mockRejectedValue(new RelayApiError("Denied", 403));
  await act(async () => { sources[0].onerror(); sources[0].onerror(); });
  await act(() => vi.advanceTimersByTimeAsync(31_000));
  expect(sources).toHaveLength(1);
  view.unmount(); client.clear();
  const disabled = setup(false);
  expect(sources).toHaveLength(0);
  disabled.view.unmount(); disabled.client.clear();
});

it("drops an HTTP recovery response after switching sessions", async () => {
  const { client, view } = setup();
  let resolve!: (value: any) => void;
  vi.mocked(getSession).mockImplementation(() => new Promise(done => { resolve = done; }));
  act(() => sources[0].onerror());
  view.rerender({ id: "other" });
  await act(async () => resolve({ ...initial, status: "completed" }));
  expect(client.getQueryData<any[]>(key)?.[0].status).toBe("running");
  view.unmount(); client.clear();
});

it("keeps backing off a stream that drops right after opening, and resets once one holds", async () => {
  const { client, view } = setup();
  vi.mocked(getSession).mockResolvedValue({ ...initial } as never);
  act(() => sources[0].onopen());
  await act(async () => sources[0].onerror());
  await act(() => vi.advanceTimersByTimeAsync(1_000));
  expect(sources).toHaveLength(2);
  act(() => sources[1].onopen());
  await act(async () => sources[1].onerror());
  await act(() => vi.advanceTimersByTimeAsync(1_000));
  expect(sources).toHaveLength(2);
  await act(() => vi.advanceTimersByTimeAsync(1_000));
  expect(sources).toHaveLength(3);
  act(() => sources[2].onopen());
  await act(() => vi.advanceTimersByTimeAsync(10_000));
  await act(async () => sources[2].onerror());
  await act(() => vi.advanceTimersByTimeAsync(1_000));
  expect(sources).toHaveLength(4);
  view.unmount(); client.clear();
});

it("reports the stream connected from open until it errors, closes, or unmounts", async () => {
  const { client, view } = setup();
  vi.mocked(getSession).mockResolvedValue({ ...initial } as never);
  expect(isSessionStreamConnected()).toBe(false);
  act(() => sources[0].onopen());
  expect(isSessionStreamConnected()).toBe(true);
  await act(async () => sources[0].onerror());
  expect(isSessionStreamConnected()).toBe(false);
  await act(() => vi.advanceTimersByTimeAsync(1_000));
  act(() => sources[1].onopen());
  expect(isSessionStreamConnected()).toBe(true);
  act(() => sources[1].listeners.get("done")!({ data: JSON.stringify({ status: "completed" }) }));
  expect(isSessionStreamConnected()).toBe(false);
  act(() => sources[1].onopen());
  view.unmount();
  expect(isSessionStreamConnected()).toBe(false);
  client.clear();
});

it("commits buffered messages in arrival order before a closing stream is detached", () => {
  deferFrame.current = true;
  const { client, view } = setup();
  act(() => {
    for (const id of ["first", "second"]) {
      sources[0].onmessage({ data: JSON.stringify({
        id, type: "user.message", sessionId: "live", timestamp: "2026-09-09T00:00:00Z", text: id,
      }) });
    }
    sources[0].listeners.get("done")!({ data: JSON.stringify({ status: "completed" }) });
  });
  expect(client.getQueryData<RelaySession[]>(key)?.[0].events.map(event => event.id)).toEqual(["first", "second"]);
  view.unmount();
  client.clear();
});
