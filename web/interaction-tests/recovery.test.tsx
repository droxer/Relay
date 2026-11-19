import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { it, expect, vi } from "vitest";
import type { ReactNode } from "react";
import { useRelayMutations } from "../src/hooks/useRelayMutations";
import { useSessionEvents } from "../src/hooks/useSessionEvents";
import { useSessionDetail } from "../src/hooks/useSessionDetail";
import { deleteSession, getSession, RelayApiError, submitThreadMessage } from "../src/api";
import { threadMessageInput } from "../src/lib/messageRouting";
import type { RelaySession } from "../src/types";
import { TASK_RECORD_QUERY_KEY } from "../src/hooks/useTaskRecord";
vi.mock("../src/api", async () => ({
  deleteSession: vi.fn(),
  getSession: vi.fn(),
  submitThreadMessage: vi.fn(),
  RelayApiError: (await import("../src/api-client/client")).RelayApiError,
}));
vi.mock("../src/components/ui/DialogProvider", () => ({ useDialogs: () => ({ announce: vi.fn() }) }));
vi.mock("../src/hooks/useMutationError", () => ({ useMutationError: () => ({ reportMutationError: vi.fn() }) }));
const key = ["relay", "sessions"];
const session = (id: string, events: any[] = []) => ({ id, status: "running", events, agentRuns: [], artifacts: [] });
function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return { client, wrapper };
}

it("refreshes the rejected message's thread when a run starts before the composer sees it", async () => {
  const { client, wrapper } = setup();
  const stale = { ...session("busy"), status: "completed" };
  const busy = { ...session("busy", [{ id: "new-run" }]), execution: { phase: "running" } } as RelaySession;
  const other = session("other");
  client.setQueryData(key, [stale, other]);
  const conflict = new RelayApiError("Thread already has a run.", 409, "thread_run_active");
  vi.mocked(submitThreadMessage).mockRejectedValueOnce(conflict);
  vi.mocked(getSession).mockResolvedValueOnce(busy);
  const { result } = renderHook(() => useRelayMutations(), { wrapper });
  await act(async () => {
    const input = threadMessageInput({ text: "Keep this message", addressAgentIds: [], userMessageId: "evt_followup" });
    await expect(result.current.submitThreadMessageMutation.mutateAsync({ sessionId: stale.id, input })).rejects.toBe(conflict);
  });
  await waitFor(() => {
    const rows = client.getQueryData<RelaySession[]>(key);
    expect(rows?.find(row => row.id === stale.id)?.execution).toEqual(busy.execution);
    expect(rows?.find(row => row.id === other.id)).toEqual(other);
  });
  expect(getSession).toHaveBeenCalledWith(stale.id, expect.any(AbortSignal));
  client.clear();
});

it("refreshes cached task details after deleting a linked thread", async () => {
  const { client, wrapper } = setup();
  const taskKey = [TASK_RECORD_QUERY_KEY, "linked-task"];
  client.setQueryData(taskKey, { id: "linked-task", linkedSessionIds: ["deleted", "remaining"] });
  const fetchTask = vi.fn().mockResolvedValue({ id: "linked-task", linkedSessionIds: ["remaining"] });
  vi.mocked(deleteSession).mockResolvedValue(undefined);
  const view = renderHook(() => ({
    task: useQuery({ queryKey: taskKey, queryFn: fetchTask, staleTime: Infinity }),
    mutations: useRelayMutations(),
  }), { wrapper });
  expect(view.result.current.task.data?.linkedSessionIds).toEqual(["deleted", "remaining"]);
  await act(async () => {
    await view.result.current.mutations.deleteSessionMutation.mutateAsync({ sessionId: "deleted" });
  });
  await waitFor(() => expect(view.result.current.task.data?.linkedSessionIds).toEqual(["remaining"]));
  expect(fetchTask).toHaveBeenCalledTimes(1);
  view.unmount();
  client.clear();
});
it("keeps a thread visible while deletion is pending and preserves streamed output on failure", async () => {
  const { client, wrapper } = setup();
  let reject!: (error: Error) => void;
  vi.mocked(deleteSession).mockImplementation(() => new Promise((_, fail) => { reject = fail; }));
  client.setQueryData(key, [session("deleted"), session("live")]);
  const { result } = renderHook(() => useRelayMutations(), { wrapper });
  act(() => result.current.deleteSessionMutation.mutate({ sessionId: "deleted" }));
  await waitFor(() => expect(reject).toBeTypeOf("function"));
  const live = session("live", [{ id: "new-output" }]);
  expect(client.getQueryData<any[]>(key)?.some(s => s.id === "deleted")).toBe(true);
  client.setQueryData(key, [session("deleted"), live]);
  act(() => reject(new Error("offline")));
  await waitFor(() => expect(result.current.deleteSessionMutation.isError).toBe(true));
  expect(client.getQueryData<any[]>(key)?.find(s => s.id === "live")).toEqual(live);
  expect(client.getQueryData<any[]>(key)?.some(s => s.id === "deleted")).toBe(true);
  client.clear();
});
it("restarts a closed SSE connection after a transient failure", async () => {
  vi.useFakeTimers();
  const sources: any[] = [];
  vi.stubGlobal("EventSource", class {
    static CLOSED = 2;
    readyState = 2;
    close = vi.fn(); addEventListener = vi.fn();
    constructor() { sources.push(this); }
  });
  const { client, wrapper } = setup();
  client.setQueryData(key, [session("live")]);
  vi.mocked(getSession).mockResolvedValue(session("live") as any);
  const view = renderHook(() => useSessionEvents("live", true), { wrapper });
  act(() => sources[0].onerror());
  await act(() => vi.advanceTimersByTimeAsync(31_000));
  expect(sources.length).toBeGreaterThan(1);
  view.unmount(); client.clear(); vi.useRealTimers(); vi.unstubAllGlobals();
});
it("reconciles a selected thread after a summary reports completion", async () => {
  vi.useFakeTimers();
  const { client, wrapper } = setup();
  client.setQueryData(key, [session("live")]);
  vi.mocked(getSession).mockResolvedValue(session("live") as any);
  const view = renderHook(() => useSessionDetail("live", true), { wrapper });
  await act(async () => {});
  const completed = { ...session("live", [{ id: "final-output" }]), status: "completed" };
  vi.mocked(getSession).mockResolvedValue(completed as any);
  client.setQueryData(key, [{ ...session("live"), status: "completed", updatedAt: "new" }]);
  await act(() => vi.advanceTimersByTimeAsync(5_000));
  expect(client.getQueryData<any[]>(key)?.[0].events).toEqual(completed.events);
  view.unmount(); client.clear(); vi.useRealTimers();
});

it("shows pending deletion until the backend confirms completion", async () => {
  const { client, wrapper } = setup();
  const pending = { phase: "stopping", canDelete: false, deletionRequested: true } as any;
  vi.mocked(deleteSession).mockResolvedValue(pending);
  client.setQueryData(key, [session("deleting"), session("live")]);
  const { result } = renderHook(() => useRelayMutations(), { wrapper });
  await act(async () => { await result.current.deleteSessionMutation.mutateAsync({ sessionId: "deleting" }); });
  expect(client.getQueryData<any[]>(key)?.find(s => s.id === "deleting")?.execution).toEqual(pending);
  vi.mocked(deleteSession).mockResolvedValue(undefined);
  await act(async () => { await result.current.deleteSessionMutation.mutateAsync({ sessionId: "deleting" }); });
  expect(client.getQueryData<any[]>(key)?.map(s => s.id)).toEqual(["live"]);
  client.clear();
});
