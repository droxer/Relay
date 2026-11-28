import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { materializeEvents, relayEvent } from "relay-core";
import type { RelaySession, RelayTaskSummary, SessionSummariesResponse } from "../src/types";
import { applySessionEvent } from "../src/lib/sessionEvents";
import { homeQueue } from "../src/lib/homeQueue";
import { useTaskRoute } from "../src/hooks/useLocationPathname";
import { useRelayData } from "../src/hooks/useRelayData";
import { useThreadTaskContext } from "../src/hooks/useThreadTaskContext";
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

it("backs the sessions poll off while the session stream is connected", async () => {
  vi.mocked(listSandboxes).mockResolvedValue({ sandboxes: [] } as never);
  const { client, view } = setup();
  const sessionsQuery = () => client.getQueryCache().find({ queryKey: ["relay", "sessions"], exact: true });
  const interval = () => {
    const query = sessionsQuery()!;
    const option = query.observers[0]?.options.refetchInterval;
    return typeof option === "function" ? option(query) : option;
  };
  await waitFor(() => expect(interval()).toBe(RELAY_POLL_INTERVALS_MS.idleCollections));
  act(() => client.setQueryData(["relay", "sessions"], [{ id: "live", status: "running", events: [] }]));
  await waitFor(() => expect(interval()).toBe(RELAY_POLL_INTERVALS_MS.sessions));
  act(() => setSessionStreamConnected(true));
  await waitFor(() => expect(interval()).toBe(RELAY_POLL_INTERVALS_MS.sessionsWhileStreaming));
  act(() => setSessionStreamConnected(false));
  await waitFor(() => expect(interval()).toBe(RELAY_POLL_INTERVALS_MS.sessions));
  const projects = client.getQueryCache().find({ queryKey: ["relay", "projects"], exact: true });
  expect(projects?.observers[0]?.options.refetchInterval).toBe(RELAY_POLL_INTERVALS_MS.projects);
  view.unmount(); client.clear();
});

it.each(["notification", "reconnect", "return to Activity"])("shows a Task Thread after %s without waiting for the list poll", async (trigger) => {
  class ActivitySource extends EventTarget {
    constructor(public url: string, public options: EventSourceInit) {
      super();
      streams.push(this);
    }
    close = vi.fn();
  }
  const streams: ActivitySource[] = [];
  vi.stubGlobal("EventSource", ActivitySource);
  vi.mocked(listSessionSummaries).mockResolvedValueOnce({ sessions: [], homeTaskNeedsYou: 0 });
  const client = new QueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const view = renderHook(({ visible }) => useRelayData(undefined, true, false, visible, true), {
    wrapper, initialProps: { visible: true },
  });
  act(() => streams[0]?.dispatchEvent(new Event("open")));
  await waitFor(() => expect(view.result.current.sessionsLoading).toBe(false));
  expect(view.result.current.sessions).toEqual([]);
  if (trigger === "return to Activity") view.rerender({ visible: false });

  const now = new Date().toISOString();
  vi.mocked(listSessionSummaries).mockResolvedValueOnce({
    sessions: [{
      id: "task-thread", taskGoal: "Scheduled report", status: "running", phase: "running",
      workspacePath: "/workspace", createdAt: now, updatedAt: now, eventCount: 2, artifactCount: 0, runCount: 1,
      taskActivity: { origin: { kind: "backlog", taskId: "task", ref: "#1", title: "Scheduled report", status: "running" }, awaitsHuman: false },
    }],
    homeTaskNeedsYou: 0,
  });
  if (trigger === "return to Activity") view.rerender({ visible: true });
  const source = streams.at(-1);
  act(() => source?.dispatchEvent(new Event(trigger === "notification" ? "changed" : "open")));
  await waitFor(() => expect(view.result.current.sessions).toMatchObject([
    { id: "task-thread", status: "running", taskActivity: { origin: { kind: "backlog" } } },
  ]));
  expect(source && new URL(source.url, location.origin).pathname).toBe("/api/v1/threads/activity/changes");
  expect(source?.options).toEqual({ withCredentials: true });
  view.unmount();
  expect(source?.close).toHaveBeenCalledOnce();
  client.clear();
});

it.each(["changed", "open"])("clears a completed review from Up next after Activity %s", async (event) => {
  const streams: EventTarget[] = [];
  class ActivitySource extends EventTarget {
    constructor() {
      super();
      streams.push(this);
    }
    close() {}
  }
  vi.stubGlobal("EventSource", ActivitySource);
  const client = new QueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const task: RelayTaskSummary = {
    id: "task", title: "Latest review", description: "", status: "review", priority: "normal",
    ownerUserId: "alice", projectId: "project", linkedSessionIds: ["thread"], eventCount: 1, activityCount: 0,
    createdAt: "2026-11-28T07:00:00Z", updatedAt: "2026-11-28T07:00:00Z",
  };
  vi.mocked(listTasks).mockResolvedValueOnce({ tasks: [task] });
  vi.mocked(listSessionSummaries).mockResolvedValueOnce({ sessions: [], homeTaskNeedsYou: 1 });
  const view = renderHook(() => {
    const { tasks, homeTaskNeedsYou } = useRelayData(undefined, true, true, true, false, undefined, "home", { projectDirectory: false });
    const rows = homeQueue({ tasks, sessions: [], nodes: [], userId: "alice", today: "2026-11-28" });
    return { count: homeTaskNeedsYou, rows: rows.map(item => item.kind) };
  }, { wrapper });
  try {
    act(() => streams[0].dispatchEvent(new Event("open")));
    await waitFor(() => expect(view.result.current).toEqual({ count: 1, rows: ["review"] }));
    vi.mocked(listTasks).mockResolvedValueOnce({ tasks: [{ ...task, status: "done", eventCount: 2 }] });
    vi.mocked(listSessionSummaries).mockResolvedValueOnce({ sessions: [], homeTaskNeedsYou: 0 });
    act(() => streams[0].dispatchEvent(new Event(event)));
    await waitFor(() => expect(view.result.current).toEqual({ count: 0, rows: [] }));
  } finally {
    view.unmount(); client.clear();
    vi.unstubAllGlobals();
    vi.mocked(listTasks).mockReset().mockResolvedValue({ tasks: [] });
    vi.mocked(listSessionSummaries).mockReset().mockResolvedValue({ sessions: [] });
  }
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
    const { visible: needsTasks } = useTaskRoute();
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
    const { visible, projectId, scope } = useTaskRoute();
    return useRelayData(undefined, true, visible, true, !visible, projectId, scope);
  }, { wrapper });
  try {
    await waitFor(() => expect(listTasks).toHaveBeenCalledTimes(1));
    expect(vi.mocked(listTasks).mock.calls[0][1]).toMatchObject({ projectId: "project-a", scope: "project-dashboard" });
    go("/projects/project-b?tab=tasks");
    await waitFor(() => expect(listTasks).toHaveBeenCalledTimes(2));
    expect(vi.mocked(listTasks).mock.calls[1][1]).toMatchObject({ projectId: "project-b", scope: "board" });
    go("/projects/project-b?task=task-b");
    go("/projects/project-b?tab=automations");
    await waitFor(() => expect(listTasks).toHaveBeenCalledTimes(3));
    expect(vi.mocked(listTasks).mock.calls[2][1]).toMatchObject({ projectId: "project-b", scope: "automations" });
    go("/tasks");
    await waitFor(() => expect(listTasks).toHaveBeenCalledTimes(4));
    const calls = vi.mocked(listTasks).mock.calls;
    expect(calls[3][1]).toMatchObject({ projectId: undefined, scope: "issues" });
    expect(new Set(calls.map(call => call[1])).size).toBe(4);
    calls[0][1]!.etag = '"project-a-validator"';
    await act(() => client.invalidateQueries({ queryKey: ["relay", "tasks", "project-a"], refetchType: "none" }));
    go("/projects/project-a");
    await waitFor(() => expect(listTasks).toHaveBeenCalledTimes(5));
    expect(vi.mocked(listTasks).mock.calls[4][1]?.etag).toBe('"project-a-validator"');
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
  const interval = () => {
    const query = taskQuery()!;
    const option = query.observers[0]?.options.refetchInterval;
    return typeof option === "function" ? option(query) : option;
  };
  expect(interval()).toBe(60_000);
  const before = vi.mocked(listTasks).mock.calls.length;
  view.rerender({ visible: true });
  await act(async () => {});
  expect(listTasks).toHaveBeenCalledTimes(before);
  view.rerender({ visible: false });
  // A later visit reconciles stale data without invalidating a fresh cache.
  act(() => client.setQueryData(["relay", "tasks"], [], { updatedAt: Date.now() - 60_000 }));
  view.rerender({ visible: true });
  await waitFor(() => expect(listTasks).toHaveBeenCalledTimes(before + 1));
  expect(interval()).toBe(RELAY_POLL_INTERVALS_MS.idleCollections);
  act(() => client.setQueryData(["relay", "tasks"], [{ id: "active", status: "running" }]));
  expect(interval()).toBe(RELAY_POLL_INTERVALS_MS.tasks);
  view.unmount(); client.clear();
});

it("reconciles new suggestions for the open Thread without refreshing for ordinary transcript output", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const list = vi.mocked(listTasks).mockClear();
  const context = { threadId: "thread", eventCount: 3, activeTaskId: null, nextSteps: [] };
  const suggestion = "Write the follow-up test";
  list.mockResolvedValueOnce({ tasks: [], threadTaskContext: context });
  list.mockResolvedValueOnce({ tasks: [], threadTaskContext: { ...context, eventCount: 6, nextSteps: [suggestion] } });
  const view = renderHook(({ session }: { session?: RelaySession }) => {
    const data = useRelayData(undefined, true, true, true, false, undefined, undefined, { threadId: "thread" });
    return useThreadTaskContext(session, data.threadTaskContext, data.tasks);
  }, { wrapper, initialProps: { session: undefined } as { session?: RelaySession } });
  try {
    await waitFor(() => expect(client.isFetching()).toBe(0));
    expect(list).toHaveBeenCalledTimes(1);
    expect(list.mock.calls[0][1]).toMatchObject({ threadId: "thread" });
    view.rerender({ session: { id: "thread", eventStart: 4, events: [] } as unknown as RelaySession });
    await act(async () => {});
    expect(list).toHaveBeenCalledTimes(1);
    view.rerender({ session: { id: "thread", eventStart: 6, events: [], nextSteps: [suggestion] } as unknown as RelaySession });
    expect(view.result.current).toBe(false);
    await waitFor(() => expect(view.result.current).toBe(true));
    expect(list.mock.calls.map(call => call[1]?.threadId)).toEqual(["thread", "thread"]);
  } finally {
    view.unmount(); client.clear();
  }
});

it("shows an automatic Task as Done when its Thread closes, before polling", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const threadId = "task-thread";
  const created = relayEvent("session.created", threadId, {
    workspacePath: "/workspace", taskGoal: "Fix the test", participants: ["human", "codex"],
  });
  const started = relayEvent("agent.started", threadId, { agent: "codex", runId: "run" });
  const running = materializeEvents([created, started]);
  const task: RelayTaskSummary = {
    id: "task", title: "Fix the test", description: "", status: "running", priority: "normal",
    acceptancePolicy: "automatic", linkedSessionIds: [threadId], createdAt: created.timestamp,
    updatedAt: started.timestamp, activityCount: 0, eventCount: 3,
  };
  const context = { threadId, eventCount: 2, activeTaskId: null, nextSteps: [] };
  const list = vi.mocked(listTasks).mockClear();
  list.mockResolvedValueOnce({ tasks: [task], threadTaskContext: context });
  const view = renderHook(({ session }: { session: RelaySession }) => {
    const data = useRelayData(undefined, true, true, true, false, undefined, undefined, { threadId });
    useThreadTaskContext(session, data.threadTaskContext, data.tasks);
    return data.tasks[0]?.status;
  }, { wrapper, initialProps: { session: running } });
  try {
    await waitFor(() => expect(view.result.current).toBe("running"));
    const agentExited = applySessionEvent(running, relayEvent("agent.completed", threadId, {
      agent: "codex", runId: "run", status: "completed", exitCode: 0,
    }));
    view.rerender({ session: agentExited });
    await act(async () => {});
    expect(list).toHaveBeenCalledTimes(1);
    expect(view.result.current).toBe("running");

    list.mockResolvedValueOnce({
      tasks: [{ ...task, status: "done", eventCount: 4 }],
      threadTaskContext: { ...context, eventCount: 4 },
    });
    const closed = applySessionEvent(agentExited, relayEvent("session.completed", threadId, { outcome: "Done" }));
    const tail = { ...closed, eventStart: 2, events: closed.events.slice(2) };
    view.rerender({ session: tail });
    await waitFor(() => expect(view.result.current).toBe("done"));
    view.rerender({ session: applySessionEvent(tail, relayEvent("session.renamed", threadId, { title: "Renamed" })) });
    await act(async () => {});
    expect(list.mock.calls.map(call => call[1]?.threadId)).toEqual([threadId, threadId]);
  } finally {
    view.unmount(); client.clear();
  }
});

it("uses a separate Task query and validator for each Computer board", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const api = vi.mocked(listTasks).mockClear();
  const view = renderHook(({ computerId }) =>
    useRelayData(undefined, true, true, true, false, undefined, "board", { computerId }),
  { wrapper, initialProps: { computerId: "device:first" } });
  try {
    await waitFor(() => expect(view.result.current.tasksStatus).toBe("ready"));
    view.rerender({ computerId: "device:second" });
    await waitFor(() => expect(api).toHaveBeenCalledTimes(2));
    expect(api.mock.calls.map(call => call[1]?.computerId)).toEqual(["device:first", "device:second"]);
    expect(api.mock.calls[0][1]).not.toBe(api.mock.calls[1][1]);
  } finally {
    view.unmount(); client.clear();
  }
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
