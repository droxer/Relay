import { act, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { getSession } from "../src/api";
import { ExecutionRecoveryPanel } from "../src/components/ExecutionRecoveryPanel";
import { QueuedRunCard } from "../src/components/QueuedRunCard";
import { useSessionEvents } from "../src/hooks/useSessionEvents";
import { useSessionDetail } from "../src/hooks/useSessionDetail";
import { queuedRun } from "../src/lib/queuedRun";
import { setSessionStreamConnected } from "../src/lib/sessionStreamStatus";
import type { RelaySession } from "../src/types";

vi.mock("../src/components/ui/DialogProvider", () => ({ useDialogs: () => ({ confirm: vi.fn() }) }));
vi.mock("../src/api", () => ({ getSession: vi.fn(), RelayApiError: class extends Error {} }));
vi.mock("../src/lib/frameScheduler", () => ({
  browserFrameSchedulerHost: () => ({}),
  createFrameScheduler: () => ({ request: (callback: () => void) => callback(), cancel: vi.fn() }),
}));
class Source {
  close = vi.fn();
  onmessage!: (event: { data: string }) => void;
  addEventListener() {}
  constructor() { sources.push(this); }
}
let sources: Source[] = [];
const key = ["relay", "sessions"];
const queued = {
  id: "live", status: "running", events: [], agentRuns: [], artifacts: [],
  execution: { phase: "queued", queuedAt: "2026-11-13T12:00:00Z", executionConfirmed: false,
    canDelete: false, deletionRequested: false, blockingReason: "awaiting_dispatch",
    lastConfirmedAt: null, nextRecoveryAt: null },
} as unknown as RelaySession;

function OpenThread() {
  useSessionDetail("live", true);
  useSessionEvents("live", true);
  const { data } = useQuery<RelaySession[]>({ queryKey: key, queryFn: async () => [queued], enabled: false });
  const waiting = data?.[0] && queuedRun(data[0]);
  return <>
    {waiting ? <QueuedRunCard queued={waiting} node={null} /> : <p>reply</p>}
    {data?.[0] ? <ExecutionRecoveryPanel session={data[0]} /> : null}
  </>;
}

afterEach(() => { setSessionStreamConnected(false); sources = []; });

it.each(["running", "terminal"] as const)("removes the mounted queue card when execution becomes %s without navigating", async phase => {
  vi.useFakeTimers();
  vi.stubGlobal("EventSource", Source);
  setSessionStreamConnected(true);
  const client = new QueryClient();
  client.setQueryData(key, [queued]);
  vi.mocked(getSession).mockResolvedValueOnce(queued).mockResolvedValue({
    ...queued, execution: { ...queued.execution!, phase, queuedAt: null },
  });
  const view = render(<QueryClientProvider client={client}><OpenThread /></QueryClientProvider>);
  await act(async () => {});
  expect(screen.queryByRole("region", { name: "thread.execution_queued" })).toBeTruthy();
  expect(getSession).toHaveBeenCalledTimes(1);

  // No new text or session.status event, and no selection change: dispatch
  // and a quiet/fast run must still remove the already-mounted queue card.
  await act(() => vi.advanceTimersByTimeAsync(5_000));
  expect(getSession).toHaveBeenCalledTimes(2);
  expect(client.getQueryData<RelaySession[]>(key)?.[0].execution?.phase).toBe(phase);
  await act(() => vi.advanceTimersByTimeAsync(1));
  expect(screen.queryByRole("region", { name: "thread.execution_queued" })).toBeNull();
  await act(() => vi.advanceTimersByTimeAsync(15_000));
  expect(getSession).toHaveBeenCalledTimes(2);
  view.unmount();
  client.clear();
});

it("removes the mounted queue card on the first SSE output without waiting for the detail poll", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("EventSource", Source);
  const client = new QueryClient();
  const starting = { ...queued, agentRuns: [{ id: "run", status: "running" }] } as RelaySession;
  client.setQueryData(key, [starting]);
  vi.mocked(getSession).mockResolvedValue(starting);
  const view = render(<QueryClientProvider client={client}><OpenThread /></QueryClientProvider>);
  await act(async () => {});
  expect(screen.queryByRole("region", { name: "thread.execution_queued" })).toBeTruthy();
  act(() => sources[0].onmessage({ data: JSON.stringify({
    id: "output", type: "agent.output", sessionId: "live", runId: "run", agent: "claude",
    stream: "stdout", text: "Working", sequence: 0, timestamp: "2026-11-13T12:00:01Z",
  }) }));
  await act(() => vi.advanceTimersByTimeAsync(1));
  expect(screen.queryByRole("region", { name: "thread.execution_queued" })).toBeNull();
  expect(getSession).toHaveBeenCalledTimes(1);
  view.unmount();
  client.clear();
});

it.each([
  ["unresponsive", "execution_unconfirmed", "running"],
  ["unresponsive", "execution_unconfirmed", "terminal"],
  ["recovery_required", "execution_lost", "running"],
  ["recovery_required", "execution_lost", "terminal"],
  ["stopping", "awaiting_termination", "terminal"],
  ["finalizing", "saving_results", "terminal"],
] as const)("updates the mounted %s (%s) notice when execution becomes %s without navigating", async (phase, reason, recoveredPhase) => {
  vi.useFakeTimers();
  vi.stubGlobal("EventSource", Source);
  setSessionStreamConnected(true);
  const client = new QueryClient();
  const stalled: RelaySession = { ...queued, execution: { ...queued.execution!, phase, blockingReason: reason, queuedAt: null } };
  client.setQueryData(key, [stalled]);
  vi.mocked(getSession).mockResolvedValueOnce(stalled).mockResolvedValue({
    ...stalled, execution: { ...stalled.execution!, phase: recoveredPhase, blockingReason: null },
  });
  const view = render(<QueryClientProvider client={client}><OpenThread /></QueryClientProvider>);
  await act(async () => {});
  expect(screen.queryByRole("region", { name: "recovery.title" })).toBeTruthy();
  // Renewed leases or received exit evidence need not change Thread status
  // or emit a new SSE event. Keep the same selection and status throughout.
  await act(() => vi.advanceTimersByTimeAsync(5_000));
  expect(getSession).toHaveBeenCalledTimes(2);
  await act(() => vi.advanceTimersByTimeAsync(1));
  expect(screen.queryByRole("region", { name: "recovery.title" })).toBeNull();
  await act(() => vi.advanceTimersByTimeAsync(15_000));
  expect(getSession).toHaveBeenCalledTimes(2);
  view.unmount();
  client.clear();
});

it("keeps the recovery notice for late output and an online computer until execution is confirmed", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("EventSource", Source);
  setSessionStreamConnected(true);
  const client = new QueryClient();
  const stalled = { ...queued, agentRuns: [{ id: "run", status: "running" }],
    execution: { ...queued.execution!, phase: "unresponsive", blockingReason: "execution_unconfirmed", computerOnline: false },
  } as RelaySession;
  client.setQueryData(key, [stalled]);
  const online = { ...stalled, execution: { ...stalled.execution!, computerOnline: true } };
  vi.mocked(getSession).mockResolvedValueOnce(stalled).mockResolvedValue(online);
  const view = render(<QueryClientProvider client={client}><OpenThread /></QueryClientProvider>);
  await act(async () => {});
  act(() => sources[0].onmessage({ data: JSON.stringify({
    id: "late", type: "agent.output", sessionId: "live", runId: "run", agent: "claude",
    stream: "stdout", text: "Buffered output", sequence: 0, timestamp: "2026-11-13T12:00:01Z",
  }) }));
  await act(() => vi.advanceTimersByTimeAsync(1));
  expect(screen.queryByRole("region", { name: "recovery.title" })).toBeTruthy();
  await act(() => vi.advanceTimersByTimeAsync(5_000));
  expect(screen.queryByRole("region", { name: "recovery.title" })).toBeTruthy();
  expect(screen.getByText("recovery.online_exit_unconfirmed.title")).toBeTruthy();
  vi.mocked(getSession).mockResolvedValue({ ...online, execution: { ...online.execution!, phase: "running" } });
  await act(() => vi.advanceTimersByTimeAsync(5_000));
  await act(() => vi.advanceTimersByTimeAsync(1));
  expect(screen.queryByRole("region", { name: "recovery.title" })).toBeNull();
  view.unmount();
  client.clear();
});
