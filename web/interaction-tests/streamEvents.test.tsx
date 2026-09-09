import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { useSessionEvents } from "../src/hooks/useSessionEvents";
import { getSession, RelayApiError } from "../src/api";
vi.mock("../src/api", () => ({ getSession: vi.fn(), RelayApiError: class extends Error { constructor(message: string, public status: number) { super(message); } } }));
vi.mock("../src/lib/frameScheduler", () => ({ browserFrameSchedulerHost: () => ({}), createFrameScheduler: () => ({ request: (callback: () => void) => callback(), cancel: vi.fn() }) }));
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
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

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
