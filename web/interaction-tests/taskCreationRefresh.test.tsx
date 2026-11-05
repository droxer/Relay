import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { expect, it, vi } from "vitest";
import { useRelayData } from "../src/hooks/useRelayData";
import { useRelayMutations } from "../src/hooks/useRelayMutations";
import { createTask, listTasks } from "../src/api";
import type { RelayTask } from "../src/types";

vi.mock("../src/api", async (original) => ({
  ...await original<typeof import("../src/api")>(),
  listSandboxes: vi.fn(async () => ({ sandboxes: [] })),
  listDaemonNodes: vi.fn(async () => ({ nodes: [] })),
  listSessionSummaries: vi.fn(async () => ({ sessions: [] })),
  listTasks: vi.fn(async () => ({ tasks: [] })),
  listProjects: vi.fn(async () => ({ projects: [] })),
  createTask: vi.fn(),
}));
vi.mock("../src/components/ui/DialogProvider", () => ({ useDialogs: () => ({ announce: vi.fn() }) }));

it.each([false, true])("shows a created project record without refreshing (automation: %s)", async (isRoutine) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const view = renderHook(() => useRelayData(undefined, true), { wrapper });
  const mutation = renderHook(() => useRelayMutations(), { wrapper });
  await waitFor(() => expect(view.result.current.tasksStatus).toBe("ready"));
  const task = { id: "new", projectId: "p", title: "New record", isRoutine, events: [], activity: [], updatedAt: "2026-11-05" } as unknown as RelayTask;
  vi.mocked(createTask).mockResolvedValue(task);
  await act(async () => { await mutation.result.current.createTaskMutation.mutateAsync({ title: task.title, projectId: "p", isRoutine }); });
  await waitFor(() => expect(view.result.current.tasks.map(t => t.id)).toContain("new"));
  view.unmount(); mutation.unmount(); client.clear();
});

it.each([false, true])("keeps the new project record when an older list fetch finishes (automation: %s)", async (isRoutine) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const view = renderHook(() => useRelayData(undefined, true), { wrapper });
  const mutation = renderHook(() => useRelayMutations(), { wrapper });
  await waitFor(() => expect(view.result.current.tasksStatus).toBe("ready"));
  let finishOldFetch!: (result: { tasks: [] }) => void;
  vi.mocked(listTasks).mockImplementationOnce(() => new Promise(resolve => { finishOldFetch = resolve; }));
  let refresh!: Promise<void>;
  act(() => { refresh = view.result.current.refresh(); });
  await waitFor(() => expect(finishOldFetch).toBeTypeOf("function"));
  const task = { id: "new", projectId: "p", title: "New record", isRoutine, events: [], activity: [], updatedAt: "2026-11-05" } as unknown as RelayTask;
  vi.mocked(createTask).mockResolvedValue(task);
  await act(async () => { await mutation.result.current.createTaskMutation.mutateAsync({ title: task.title, projectId: "p", isRoutine }); });
  await waitFor(() => expect(view.result.current.tasks.map(t => t.id)).toContain("new"));
  await act(async () => { finishOldFetch({ tasks: [] }); await refresh; });
  expect(view.result.current.tasks.map(t => t.id)).toContain("new");
  view.unmount(); mutation.unmount(); client.clear();
});
