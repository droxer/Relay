import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { it, expect, vi } from "vitest";
import type { ReactNode } from "react";
import { useRelayMutations } from "../src/hooks/useRelayMutations";
import { useSessionEvents } from "../src/hooks/useSessionEvents";
import { useSessionDetail } from "../src/hooks/useSessionDetail";
import { deleteSession, getSession } from "../src/api";
import { TASK_RECORD_QUERY_KEY } from "../src/hooks/useTaskRecord";
vi.mock("../src/api", () => ({ deleteSession: vi.fn(), getSession: vi.fn(), RelayApiError: class extends Error { constructor(public message: string, public status: number) { super(message); } } }));
vi.mock("../src/components/ui/DialogProvider", () => ({ useDialogs: () => ({ announce: vi.fn() }) }));
vi.mock("../src/hooks/useMutationError", () => ({ useMutationError: () => ({ reportMutationError: vi.fn() }) }));
const key = ["relay", "sessions"];
const session = (id: string, events: any[] = []) => ({ id, status: "running", events, agentRuns: [], artifacts: [] });
function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return { client, wrapper };
}
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
