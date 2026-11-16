import { act, render, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { configurePersonalQueryCache } from "../src/lib/personalQueryCache";
import { useRelayData, NODES_QUERY_KEY } from "../src/hooks/useRelayData";
import { ProjectWorkspaceFiles } from "../src/components/ProjectWorkspaceFiles";
import { RecordWorkspace } from "../src/components/task-record/RecordWorkspace";
import { useComputerOptions } from "../src/hooks/useComputerOptions";
import { useTaskRecord } from "../src/hooks/useTaskRecord";
import { useSkill, useSkills } from "../src/hooks/useSkills";
import { useDashboardSessions } from "../src/hooks/useDashboardSessions";
import { useTokenUsage } from "../src/hooks/useTokenUsage";
import { useTagCatalog } from "../src/hooks/useTagCatalog";
import { getTask, getSkill, listSkills, listDaemonNodes, listProjectWorkspaceFiles, listTaskWorkspaceFiles, getDashboardSessions, getDashboardTokens } from "../src/api";
import { listTags } from "../src/api-client/tags";
import type { RelayTaskListItem } from "../src/types";

vi.mock("../src/api", () => ({
  listSandboxes: vi.fn(async () => ({ sandboxes: [] })),
  listDaemonNodes: vi.fn(async () => ({ nodes: [] })),
  listSessionSummaries: vi.fn(async () => ({ sessions: [] })),
  listTasks: vi.fn(async () => ({ tasks: [] })),
  listProjects: vi.fn(async () => ({ projects: [] })),
  getTask: vi.fn(async () => ({ id: "task", status: "done", updatedAt: "one" })),
  listProjectWorkspaceFiles: vi.fn(async () => ({ entries: [], path: "", exists: true })),
  readProjectWorkspaceFile: vi.fn(),
  listTaskWorkspaceFiles: vi.fn(async () => ({ entries: [], path: "", exists: true })),
  readTaskWorkspaceFile: vi.fn(),
  taskWorkspaceStatus: vi.fn(async () => ({ waiting: false })),
  listSkills: vi.fn(async () => ({ skills: [] })),
  getSkill: vi.fn(async () => ({ id: "skill", description: "Before" })),
  getDashboardSessions: vi.fn(async () => ({ total: 1 })),
  getDashboardTokens: vi.fn(async () => ({ available: false })),
}));
vi.mock("../src/api-client/tags", () => ({ listTags: vi.fn(async () => ({ tags: [] })) }));
beforeEach(() => { vi.clearAllMocks(); vi.useFakeTimers(); });
function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  configurePersonalQueryCache(client);
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return { client, wrapper };
}

it("Agents and Teams reuse the shell's Computer directory instead of requesting it again", async () => {
  const { client, wrapper } = setup();
  const shell = renderHook(() => useRelayData(undefined, true), { wrapper });
  await act(async () => {});
  await act(() => vi.advanceTimersByTimeAsync(2_000));
  const chooser = renderHook(() => useComputerOptions("owner", true), { wrapper });
  await act(async () => {});
  expect(listDaemonNodes).toHaveBeenCalledTimes(1);
  expect(client.getQueryData(NODES_QUERY_KEY)).toEqual([]);
  chooser.unmount(); shell.unmount(); client.clear();
});

it("task details survive page revisits and refresh when the list revision changes", async () => {
  const { client, wrapper } = setup();
  const row = { id: "task", status: "done", updatedAt: "one" } as RelayTaskListItem;
  const first = renderHook(() => useTaskRecord("task", row), { wrapper });
  await act(async () => {});
  first.unmount();
  await act(() => vi.advanceTimersByTimeAsync(2_000));
  const second = renderHook(({ revision }) => useTaskRecord("task", { ...row, updatedAt: revision }), { wrapper, initialProps: { revision: "one" } });
  await act(async () => {});
  expect(getTask).toHaveBeenCalledTimes(1);
  second.rerender({ revision: "two" });
  await act(async () => {});
  expect(getTask).toHaveBeenCalledTimes(2);
  second.unmount(); client.clear();
});

it("Skills and tags reuse fresh results while edits invalidate the relevant caches", async () => {
  const { client, wrapper } = setup();
  const read = () => ({ skills: useSkills(), skill: useSkill("skill"), tags: useTagCatalog() });
  const first = renderHook(read, { wrapper });
  await act(async () => {});
  first.unmount();
  await act(() => vi.advanceTimersByTimeAsync(2_000));
  const second = renderHook(read, { wrapper });
  await act(async () => {});
  expect(listSkills).toHaveBeenCalledTimes(1);
  expect(getSkill).toHaveBeenCalledTimes(1);
  expect(listTags).toHaveBeenCalledTimes(1);
  vi.mocked(getSkill).mockResolvedValueOnce({ id: "skill", description: "After" } as never);
  await act(async () => { await client.invalidateQueries({ queryKey: ["skills"] });
    await vi.advanceTimersByTimeAsync(0); });
  expect(second.result.current.skill.data?.description).toBe("After");
  expect(listSkills).toHaveBeenCalledTimes(2);
  expect(listTags).toHaveBeenCalledTimes(1);
  second.unmount(); client.clear();
});

it("the Admin dashboard reuses a previously viewed date range", async () => {
  const { client, wrapper } = setup();
  const first = renderHook(() => { useDashboardSessions(true, "all"); useTokenUsage("all"); }, { wrapper });
  await act(async () => {});
  first.unmount();
  await act(() => vi.advanceTimersByTimeAsync(2_000));
  const second = renderHook(() => { useDashboardSessions(true, "all"); useTokenUsage("all"); }, { wrapper });
  await act(async () => {});
  expect(getDashboardSessions).toHaveBeenCalledTimes(1);
  expect(getDashboardTokens).toHaveBeenCalledTimes(1);
  second.unmount(); client.clear();
});


it("project and task file browsers reuse their directory listings on return", async () => {
  const { client, wrapper } = setup();
  client.setQueryData(["task-record", "task"], { id: "task", status: "done" });
  const first = render(<><ProjectWorkspaceFiles projectId="project" /><RecordWorkspace taskId="task" /></>, { wrapper });
  await act(async () => {});
  first.unmount();
  await act(() => vi.advanceTimersByTimeAsync(2_000));
  const second = render(<><ProjectWorkspaceFiles projectId="project" /><RecordWorkspace taskId="task" /></>, { wrapper });
  await act(async () => {});
  expect(listProjectWorkspaceFiles).toHaveBeenCalledTimes(1);
  expect(listTaskWorkspaceFiles).toHaveBeenCalledTimes(1);
  second.unmount(); client.clear();
});

it("expires cached pages and does not reuse another account's results", async () => {
  const first = setup();
  const view = renderHook(() => useSkill("skill"), { wrapper: first.wrapper });
  await act(async () => {});
  view.unmount();
  await act(() => vi.advanceTimersByTimeAsync(31_000));
  const stale = renderHook(() => useSkill("skill"), { wrapper: first.wrapper });
  await act(async () => {});
  expect(getSkill).toHaveBeenCalledTimes(2);
  const other = setup();
  const separate = renderHook(() => useSkill("skill"), { wrapper: other.wrapper });
  await act(async () => {});
  expect(getSkill).toHaveBeenCalledTimes(3);
  stale.unmount(); separate.unmount(); first.client.clear(); other.client.clear();
});
