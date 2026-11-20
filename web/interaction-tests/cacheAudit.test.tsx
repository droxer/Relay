import { act, renderHook, waitFor } from "@testing-library/react";
import { focusManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { useRelayData } from "../src/hooks/useRelayData";
import { useTaskThreadLifecycle } from "../src/hooks/useTaskThreadLifecycle";
import { USER_AGENTS_QUERY_KEY, useAgentSetup, useUserAgents } from "../src/hooks/useUserAgents";
import { useTeams } from "../src/hooks/useTeams";
import { useDefaultAgentOffers } from "../src/hooks/useDefaultAgentOffers";
import { useWorkflowName } from "../src/hooks/useProjectWorkflows";
import { useThreadQueue } from "../src/hooks/useThreadQueue";
import { getWorkflowName, listAgentSetup, listDefaultAgentOffers, listSessionSummaries, listTasks, listTaskEvents, listUserAgents, listWorkflowPreviews, RelayApiError } from "../src/api";
import { apiJson } from "../src/api-client/client";
import { RELAY_POLL_INTERVALS_MS } from "../src/lib/relayPolling";
import type { RelayTaskListItem } from "../src/types";

vi.mock("../src/api", async () => ({
  RelayApiError: (await vi.importActual<typeof import("../src/api-client/client")>("../src/api-client/client")).RelayApiError,
  listSandboxes: vi.fn(async () => ({ sandboxes: [] })),
  listDaemonNodes: vi.fn(async () => ({ nodes: [] })),
  listSessionSummaries: vi.fn(async () => ({ sessions: [], nextCursor: "older" })),
  listTasks: vi.fn(async () => ({ tasks: [] })),
  listProjects: vi.fn(async () => ({ projects: [] })),
  listAgentSetup: vi.fn(async () => ({ view: "setup", onboardingAgents: [], defaultAgentOffers: [] })),
  listUserAgents: vi.fn(async () => ({ agents: [] })),
  listDefaultAgentOffers: vi.fn(async () => ({ offers: [] })),
  listTeams: vi.fn(async () => ({ teams: [] })),
  listTaskEvents: vi.fn(async () => ({ events: [] })),
  listWorkflowPreviews: vi.fn(),
  getWorkflowName: vi.fn(),
}));
vi.mock("../src/api-client/client", () => ({ apiJson: vi.fn(async () => ({ messages: [], paused: false })) }));
vi.mock("../src/api-client/sessions", () => ({ cancelRun: vi.fn() }));
beforeEach(() => vi.clearAllMocks());
function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return { client, wrapper };
}

it("reuses a fresh Workflow catalog row and falls back to one name read after invalidation", async () => {
  const { client, wrapper } = setup();
  client.setQueryData(["workflows", "preview", "project"], { workflows: [{ id: "workflow", name: "Cached workflow" }] });
  vi.mocked(getWorkflowName).mockResolvedValue({ workflow: { id: "workflow", name: "Renamed workflow" } } as Awaited<ReturnType<typeof getWorkflowName>>);
  const view = renderHook(() => useWorkflowName("workflow", "project"), { wrapper });
  await waitFor(() => expect(view.result.current.data).toBe("Cached workflow"));
  expect(getWorkflowName).not.toHaveBeenCalled();
  await act(() => client.invalidateQueries({ queryKey: ["workflows"] }));
  await waitFor(() => expect(view.result.current.data).toBe("Renamed workflow"));
  expect(getWorkflowName).toHaveBeenCalledExactlyOnceWith("workflow", expect.any(AbortSignal), expect.any(Object));
  expect(listWorkflowPreviews).not.toHaveBeenCalled();
  view.unmount(); client.clear();
});

it("revalidates the assigned Workflow by ID while Definition stays open", async () => {
  vi.useFakeTimers();
  focusManager.setFocused(true);
  const { client, wrapper } = setup();
  vi.mocked(getWorkflowName).mockResolvedValueOnce({ workflow: { id: "workflow", name: "Original" } } as Awaited<ReturnType<typeof getWorkflowName>>);
  vi.mocked(getWorkflowName).mockResolvedValueOnce({ workflow: { id: "workflow", name: "Renamed elsewhere" } } as Awaited<ReturnType<typeof getWorkflowName>>);
  vi.mocked(getWorkflowName).mockRejectedValueOnce(new RelayApiError("Workflow deleted", 404));
  const view = renderHook(() => useWorkflowName("workflow", "project"), { wrapper });
  try {
    await act(() => vi.advanceTimersByTimeAsync(29_999));
    expect(view.result.current.data).toBe("Original");
    expect(getWorkflowName).toHaveBeenCalledTimes(1);
    await act(() => vi.advanceTimersByTimeAsync(2));
    expect(view.result.current.data).toBe("Renamed elsewhere");
    expect(getWorkflowName).toHaveBeenCalledTimes(2);
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(view.result.current.data).toBeNull();
    expect(listWorkflowPreviews).not.toHaveBeenCalled();
  } finally {
    view.unmount();
    client.clear();
    focusManager.setFocused(undefined);
    vi.useRealTimers();
  }
});

it("keeps predefined Workflow labels local while Definition stays open", async () => {
  vi.useFakeTimers();
  focusManager.setFocused(true);
  const { client, wrapper } = setup();
  const view = renderHook(() => useWorkflowName("preset:pipeline"), { wrapper });
  try {
    await act(() => vi.advanceTimersByTimeAsync(60_001));
    expect(getWorkflowName).not.toHaveBeenCalled();
    expect(listWorkflowPreviews).not.toHaveBeenCalled();
  } finally {
    view.unmount();
    client.clear();
    focusManager.setFocused(undefined);
    vi.useRealTimers();
  }
});

it("reuses fresh collection data and paging cursors across remounts", async () => {
  const { client, wrapper } = setup();
  const first = renderHook(() => useRelayData(undefined, true), { wrapper });
  await waitFor(() => expect(first.result.current.hasMoreSessions).toBe(true));
  await waitFor(() => expect(client.isFetching()).toBe(0));
  first.unmount();
  const second = renderHook(() => useRelayData(undefined, true), { wrapper });
  await act(async () => {});
  expect(listSessionSummaries).toHaveBeenCalledTimes(1);
  expect(second.result.current.hasMoreSessions).toBe(true);
  expect(listTasks).toHaveBeenCalledTimes(1);
  second.unmount(); client.clear();
});

it("backs off offscreen workspace reads and reuses fresh tasks when returning", async () => {
  const { client, wrapper } = setup();
  const view = renderHook(({ visible }) => useRelayData(undefined, true, visible, visible), { wrapper, initialProps: { visible: false } });
  await waitFor(() => expect(client.isFetching()).toBe(0));
  const interval = (name: string) => {
    const query = client.getQueryCache().find({ queryKey: ["relay", name], exact: true })!;
    const option = query.observers[0]?.options.refetchInterval;
    return typeof option === "function" ? option(query) : option;
  };
  expect(interval("sessions")).toBe(60_000);
  expect(interval("daemon-nodes")).toBe(60_000);
  view.rerender({ visible: true });
  await act(async () => {});
  expect(listTasks).toHaveBeenCalledTimes(1);
  expect(interval("sessions")).toBe(RELAY_POLL_INTERVALS_MS.idleCollections);
  view.unmount(); client.clear();
});

it("reuses a fresh timeline on remount but reconciles a changed status", async () => {
  const { client, wrapper } = setup();
  const task = { id: "task", status: "running", linkedSessionIds: ["thread"] } as RelayTaskListItem;
  const props = { tasks: [task], session: { id: "thread", createdAt: "2026-01-01" }, currentUserId: "owner" };
  const first = renderHook(() => useTaskThreadLifecycle(props), { wrapper });
  await waitFor(() => expect(client.isFetching()).toBe(0));
  first.unmount();
  const second = renderHook(({ status }) => useTaskThreadLifecycle({ ...props, tasks: [{ ...task, status }] }), { wrapper, initialProps: { status: task.status } });
  await act(async () => {});
  expect(listTaskEvents).toHaveBeenCalledTimes(1);
  second.rerender({ status: "review" });
  await waitFor(() => expect(listTaskEvents).toHaveBeenCalledTimes(2));
  second.unmount(); client.clear();
});

it("reduces actual empty-queue requests but keeps pending messages responsive", async () => {
  vi.useFakeTimers();
  focusManager.setFocused(true);
  const { client, wrapper } = setup();
  const view = renderHook(() => useThreadQueue({ queueKey: "owner:thread", threadId: "thread", running: false, awaitsPerson: false, composerRef: { current: null } }), { wrapper });
  await act(async () => {});
  expect(apiJson).toHaveBeenCalledTimes(1);
  await act(() => vi.advanceTimersByTimeAsync(29_000));
  expect(apiJson).toHaveBeenCalledTimes(1);
  await act(() => vi.advanceTimersByTimeAsync(1_000));
  expect(apiJson).toHaveBeenCalledTimes(2);
  const pending = { messages: [{ id: "pending", text: "Next" }], paused: false };
  vi.mocked(apiJson).mockResolvedValue(pending);
  act(() => client.setQueryData(["thread-queue", "thread"], pending));
  await act(() => vi.advanceTimersByTimeAsync(3_000));
  expect(apiJson).toHaveBeenCalledTimes(5);
  view.unmount(); client.clear(); focusManager.setFocused(undefined);
});

it("preserves summary revision changes in structural sharing", async () => {
  const { shareSessions } = await import("../src/lib/sessionEvents");
  const { sessionTrailsSummary } = await import("../src/lib/sessionPollMerge");
  const row = { id: "thread", updatedAt: "same", status: "running", events: [], agentRuns: [], artifacts: [], decisions: [], summaryEventCount: 0 };
  const next = shareSessions([row] as never, [{ ...row, summaryEventCount: 1 }] as never);
  expect(sessionTrailsSummary(next[0])).toBe(true);
});


it("gives shared roster queries one polling owner", async () => {
  const { client, wrapper } = setup();
  const owner = renderHook(() => { useUserAgents("owner", true); useTeams("owner", true); }, { wrapper });
  const page = renderHook(() => { useUserAgents("owner"); useTeams("owner"); }, { wrapper });
  await waitFor(() => expect(client.isFetching()).toBe(0));
  for (const name of ["user-agents", "teams"]) {
    const observers = client.getQueryCache().find({ queryKey: [name, "owner"], exact: true })!.observers;
    expect(observers.filter(observer => observer.options.refetchInterval !== false)).toHaveLength(1);
  }
  page.unmount(); owner.unmount(); client.clear();
});

it("does not poll a second endpoint when the Agent roster includes default offers", async () => {
  const offer = { computerId: "computer", computerName: "Development", executorKinds: ["codex"] as const };
  vi.mocked(listUserAgents).mockResolvedValueOnce({
    agents: [],
    defaultAgentOffers: [{ ...offer, executorKinds: [...offer.executorKinds] }],
  });
  const { client, wrapper } = setup();
  const view = renderHook(() => {
    const roster = useUserAgents("owner", true);
    const { offers } = useDefaultAgentOffers("owner", roster.defaultAgentOffers);
    return offers;
  }, { wrapper });
  try {
    await waitFor(() => expect(view.result.current).toEqual([offer]));
    expect(listDefaultAgentOffers).not.toHaveBeenCalled();
  } finally {
    view.unmount();
    client.clear();
  }
});

it("reuses a fresh Agent roster for setup and fetches the compact view after invalidation", async () => {
  const { client, wrapper } = setup();
  const offer = { computerId: "computer", computerName: "Development", executorKinds: ["codex"] };
  client.setQueryData([USER_AGENTS_QUERY_KEY, "owner"], { agents: [], defaultAgentOffers: [offer] });
  const view = renderHook(() => useAgentSetup("owner", true), { wrapper });
  try {
    await waitFor(() => expect(view.result.current.offers).toEqual([offer]));
    expect(listAgentSetup).not.toHaveBeenCalled();
    await act(() => client.invalidateQueries({ queryKey: [USER_AGENTS_QUERY_KEY] }));
    await waitFor(() => expect(view.result.current.offers).toEqual([]));
    expect(listAgentSetup).toHaveBeenCalledTimes(1);
    expect(listUserAgents).not.toHaveBeenCalled();
  } finally {
    view.unmount();
    client.clear();
  }
});


it("performs one workspace reconciliation per minute offscreen and catches up on return", async () => {
  vi.useFakeTimers();
  focusManager.setFocused(true);
  const { client, wrapper } = setup();
  const view = renderHook(({ visible }) => useRelayData(undefined, true, false, visible), { wrapper, initialProps: { visible: false } });
  await act(async () => {});
  expect(listSessionSummaries).toHaveBeenCalledTimes(1);
  await act(() => vi.advanceTimersByTimeAsync(59_000));
  expect(listSessionSummaries).toHaveBeenCalledTimes(1);
  view.rerender({ visible: true });
  await act(async () => {});
  expect(listSessionSummaries).toHaveBeenCalledTimes(2);
  await act(() => vi.advanceTimersByTimeAsync(5_000));
  expect(listSessionSummaries).toHaveBeenCalledTimes(2);
  await act(() => vi.advanceTimersByTimeAsync(25_000));
  expect(listSessionSummaries).toHaveBeenCalledTimes(3);
  focusManager.setFocused(false);
  await act(() => vi.advanceTimersByTimeAsync(20_000));
  expect(listSessionSummaries).toHaveBeenCalledTimes(3);
  view.unmount(); client.clear(); focusManager.setFocused(undefined);
});

it("manual refresh only refetches mounted readers, leaving metadata intact", async () => {
  const { client, wrapper } = setup();
  const view = renderHook(() => useRelayData(undefined, true), { wrapper });
  await waitFor(() => expect(client.isFetching()).toBe(0));
  client.setQueryData(["relay", "session-hydration", "thread"], { status: "running", hydratedAt: Date.now() });
  await act(async () => { await view.result.current.refresh(); });
  expect(client.getQueryState(["relay", "session-hydration", "thread"])?.status).toBe("success");
  expect(listSessionSummaries).toHaveBeenCalledTimes(2);
  view.unmount(); client.clear();
});
