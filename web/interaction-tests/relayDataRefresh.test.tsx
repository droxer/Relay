import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RelaySession, SessionSummariesResponse } from "../src/types";
import { applySessionEvent } from "../src/lib/sessionEvents";
import { useProjectDashboardTaskScope, useTaskCollectionVisible } from "../src/hooks/useLocationPathname";
import { useRelayData } from "../src/hooks/useRelayData";
import { listDaemonNodes, listSandboxes, listSessionSummaries, listTasks } from "../src/api";
import { setSessionStreamConnected } from "../src/lib/sessionStreamStatus";
import { RELAY_POLL_INTERVALS_MS } from "../src/lib/relayPolling";
import * as routes from "../src/lib/appRoute";

vi.mock("../src/api", () => ({
  listSandboxes: vi.fn(),
  listDaemonNodes: vi.fn(async () => ({ nodes: [] })),
  listSessionSummaries: vi.fn(async () => ({ sessions: [] })),
  listTasks: vi.fn(async () => ({ tasks: [] })),
  listProjects: vi.fn(async () => ({ projects: [] })),
}));

function setup(threadListOnly = false) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: 1, retryDelay: 0 } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const view = renderHook(() => useRelayData("user-token", true, true, true, threadListOnly), { wrapper });
  return { client, view };
}

beforeEach(() => { setSessionStreamConnected(false); });
afterEach(() => { setSessionStreamConnected(false); });

it("keeps a refresh's token override while an overlapping plain refresh settles", async () => {
  const tokens: string[] = [];
  let failNextMinted = true;
  let releasePlainSessions: (() => void) | undefined;
  vi.mocked(listDaemonNodes).mockImplementation(async (token?: string) => {
    tokens.push(token ?? "");
    if (token === "minted" && failNextMinted) {
      failNextMinted = false;
      throw new Error("transient");
    }
    return { nodes: [] };
  });
  const { client, view } = setup();
  await waitFor(() => expect(tokens).toEqual(["user-token"]));
  await waitFor(() => expect(client.isFetching()).toBe(0));

  // A plain refresh whose nodes fetch lands while the Thread list hangs.
  vi.mocked(listSessionSummaries).mockImplementationOnce(() => new Promise((resolve) => {
    releasePlainSessions = () => resolve({ sessions: [] });
  }));
  let plain!: Promise<void>;
  act(() => { plain = view.result.current.refresh(); });
  await waitFor(() => expect(tokens).toEqual(["user-token", "user-token"]));
  await waitFor(() => expect(client.isFetching({ queryKey: ["relay", "daemon-nodes"] })).toBe(0));

  // The override refresh retries the nodes request under the minted token
  // while the plain refresh settles.
  let minted!: Promise<void>;
  act(() => { minted = view.result.current.refresh(undefined, "minted"); });
  releasePlainSessions?.();
  await act(async () => { await Promise.all([plain, minted]); });

  expect(tokens.slice(2)).toEqual(["minted", "minted"]);
  expect(view.result.current.isRefreshing).toBe(false);
  view.unmount(); client.clear();
});

it("backs the sessions poll off while the session stream is connected", async () => {
  vi.mocked(listSandboxes).mockResolvedValue({ sandboxes: [] } as never);
  const { client, view } = setup();
  const sessionsQuery = () => client.getQueryCache().find({ queryKey: ["relay", "sessions"], exact: true });
  const interval = () => (sessionsQuery()?.observers[0]?.options.refetchInterval);
  await waitFor(() => expect(interval()).toBe(RELAY_POLL_INTERVALS_MS.sessions));
  act(() => setSessionStreamConnected(true));
  await waitFor(() => expect(interval()).toBe(RELAY_POLL_INTERVALS_MS.sessionsWhileStreaming));
  act(() => setSessionStreamConnected(false));
  await waitFor(() => expect(interval()).toBe(RELAY_POLL_INTERVALS_MS.sessions));
  const projects = client.getQueryCache().find({ queryKey: ["relay", "projects"], exact: true });
  expect(projects?.observers[0]?.options.refetchInterval).toBe(RELAY_POLL_INTERVALS_MS.projects);
  view.unmount(); client.clear();
});

it("does not refetch the cookie-scoped thread list when the sandbox token changes", async () => {
  vi.mocked(listDaemonNodes).mockResolvedValue({ nodes: [] });
  vi.mocked(listSandboxes).mockClear();
  vi.mocked(listSandboxes).mockResolvedValue({ sandboxes: [] });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const view = renderHook(({ token }) => useRelayData(token, true), { wrapper, initialProps: { token: "original" } });
  await waitFor(() => expect(client.isFetching()).toBe(0));
  const before = vi.mocked(listSessionSummaries).mock.calls.length;
  view.rerender({ token: "replaced" });
  await waitFor(() => expect(listDaemonNodes).toHaveBeenLastCalledWith("replaced", expect.any(AbortSignal)));
  await waitFor(() => expect(client.isFetching()).toBe(0));
  expect(listSessionSummaries).toHaveBeenCalledTimes(before);
  expect(listSandboxes).not.toHaveBeenCalled();
  view.unmount(); client.clear();
});

it("loads tasks on the thread directory when the server lacks activity summaries", async () => {
  vi.mocked(listSandboxes).mockResolvedValue({ sandboxes: [] });
  vi.mocked(listTasks).mockClear();
  const { client, view } = setup(true);
  await waitFor(() => expect(listTasks).toHaveBeenCalledTimes(1));
  expect(view.result.current.homeTaskNeedsYou).toBeUndefined();
  view.unmount();
  client.clear();
});

it("reads Task summaries only on surfaces that display or route Task records", async () => {
  vi.mocked(listSessionSummaries).mockResolvedValue({ sessions: [], homeTaskNeedsYou: 3 });
  vi.mocked(listTasks).mockClear();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const previousUrl = window.location.href;
  const navigate = (path: string) => act(() => {
    window.history.replaceState(null, "", path);
    window.dispatchEvent(new Event(routes.APP_NAVIGATION_EVENT));
  });
  navigate("/projects/id?tab=workspace");
  const view = renderHook(() => {
    const needsTasks = useTaskCollectionVisible();
    return useRelayData(undefined, true, needsTasks, false, !needsTasks);
  }, { wrapper });
  try {
    await waitFor(() => expect(view.result.current.homeTaskNeedsYou).toBe(3));
    for (const path of ["/threads", "/threads/new", "/admin", "/channels", "/skills", "/agents", "/teams", "/computers", "/projects", "/projects/id?tab=members", "/projects/id?tab=workflows", "/projects/id?tab=settings", "/projects/id?tab=workspace"]) {
      const url = new URL(path, "http://relay.test");
      expect(routes.needsTaskCollection(routes.parseAppPath(url.pathname), url.searchParams), path).toBe(false);
    }
    for (const path of ["/home", "/threads/id", "/tasks", "/automations", "/computers/id/tasks", "/projects/id", "/projects/id?tab=tasks", "/projects/id?tab=automations", "/projects/id?task=id", "/projects/id/threads/id"]) {
      const url = new URL(path, "http://relay.test");
      expect(routes.needsTaskCollection(routes.parseAppPath(url.pathname), url.searchParams), path).toBe(true);
    }
    expect(listTasks).not.toHaveBeenCalled();
    navigate("/projects/id?tab=tasks");
    await waitFor(() => expect(listTasks).toHaveBeenCalledTimes(1));
    navigate("/projects/id?tab=settings");
    navigate("/tasks");
    await act(async () => {});
    expect(listTasks).toHaveBeenCalledTimes(1);
  } finally {
    view.unmount();
    window.history.replaceState(null, "", previousUrl);
    client.clear();
    vi.mocked(listSessionSummaries).mockResolvedValue({ sessions: [] });
  }
});

it("does not use Project Dashboard rows or their validator for the account Task board", async () => {
  vi.mocked(listTasks).mockClear();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const original = window.location.href;
  const go = (path: string) => act(() => {
    window.history.replaceState(null, "", path);
    window.dispatchEvent(new Event(routes.APP_NAVIGATION_EVENT));
  });
  go("/projects/project-a");
  const view = renderHook(() => {
    const scope = useProjectDashboardTaskScope();
    const visible = useTaskCollectionVisible();
    return useRelayData(undefined, true, visible, true, !visible, scope);
  }, { wrapper });
  try {
    await waitFor(() => expect(listTasks).toHaveBeenCalledTimes(1));
    expect(vi.mocked(listTasks).mock.calls[0][1]).toMatchObject({ projectId: "project-a" });
    go("/projects/project-b?tab=dashboard");
    await waitFor(() => expect(listTasks).toHaveBeenCalledTimes(2));
    expect(vi.mocked(listTasks).mock.calls[1][1]).toMatchObject({ projectId: "project-b" });
    go("/tasks");
    await waitFor(() => expect(listTasks).toHaveBeenCalledTimes(3));
    const calls = vi.mocked(listTasks).mock.calls;
    expect(calls[2][1]?.projectId).toBeUndefined();
    expect(new Set(calls.map(call => call[1])).size).toBe(3);
  } finally {
    view.unmount();
    window.history.replaceState(null, "", original);
    client.clear();
  }
});

it("slows task reconciliation off task surfaces and refreshes when they become visible", async () => {
  vi.mocked(listSandboxes).mockResolvedValue({ sandboxes: [] } as never);
  vi.mocked(listTasks).mockClear();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const view = renderHook(({ visible }) => useRelayData("user-token", true, visible), { wrapper, initialProps: { visible: false } });
  await waitFor(() => expect(client.isFetching()).toBe(0));
  const taskQuery = () => client.getQueryCache().find({ queryKey: ["relay", "tasks"], exact: true });
  expect(taskQuery()?.observers[0]?.options.refetchInterval).toBe(60_000);
  const before = vi.mocked(listTasks).mock.calls.length;
  view.rerender({ visible: true });
  await act(async () => {});
  expect(listTasks).toHaveBeenCalledTimes(before);
  view.rerender({ visible: false });
  // A later visit reconciles stale data without invalidating a fresh cache.
  act(() => client.setQueryData(["relay", "tasks"], [], { updatedAt: Date.now() - 60_000 }));
  view.rerender({ visible: true });
  await waitFor(() => expect(listTasks).toHaveBeenCalledTimes(before + 1));
  expect(taskQuery()?.observers[0]?.options.refetchInterval).toBe(RELAY_POLL_INTERVALS_MS.tasks);
  view.unmount(); client.clear();
});

it("commits a summary poll over the event history already written by SSE", async () => {
  vi.mocked(listSandboxes).mockResolvedValue({ sandboxes: [] } as never);
  const key = ["relay", "sessions"];
  const timestamp = "2026-10-01T00:00:00Z";
  const message = (id: string): RelaySession["events"][number] =>
    ({ id, type: "user.message", sessionId: "thread", timestamp, text: id });
  const base = {
    id: "thread", taskGoal: "Opening", createdAt: timestamp, updatedAt: timestamp,
    status: "running", phase: "created", events: [message("first")],
    agentRuns: [], artifacts: [], decisions: [],
  } as unknown as RelaySession;
  const { client, view } = setup();
  await waitFor(() => expect(client.isFetching()).toBe(0));
  client.setQueryData(key, [base]);

  let finish!: (page: SessionSummariesResponse) => void;
  vi.mocked(listSessionSummaries).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const pushMessage = (id: string) => client.setQueryData<RelaySession[]>(key, current =>
    [applySessionEvent(current![0], message(id))]);
  await act(async () => {
    const polling = client.refetchQueries({ queryKey: key, exact: true });
    finish({ sessions: [{ ...base, artifactCount: 0, runCount: 0, eventCount: 1 }] });
    // The SSE flush commits after the poll reads its response and before
    // TanStack Query stores the resolved value.
    queueMicrotask(() => pushMessage("second"));
    await polling;
    pushMessage("third");
  });

  expect(client.getQueryData<RelaySession[]>(key)?.[0].events.map(event => event.id))
    .toEqual(["first", "second", "third"]);
  view.unmount();
  client.clear();
});
