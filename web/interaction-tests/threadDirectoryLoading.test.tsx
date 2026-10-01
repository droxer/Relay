import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useMemo, type ReactNode } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { listControlPanelDaemonNodes } from "../src/api";
import { useLocalDaemonNodes } from "../src/hooks/useLocalDaemonNodes";
import { useThreadDirectory } from "../src/hooks/useThreadDirectory";
import { mergeThreadRuntimeNodes, mergeVisibleDaemonNodes } from "../src/lib/daemonNodes";
import type { ControlPanelDaemonNodeRecord, DaemonNodeMonitorRecord, RelaySession } from "../src/types";

vi.mock("../src/api", () => ({ listControlPanelDaemonNodes: vi.fn() }));
beforeEach(() => { vi.mocked(listControlPanelDaemonNodes).mockReset(); });

const nodes: DaemonNodeMonitorRecord[] = [];
const projects: [] = [];
const tasks: [] = [];
const logicalAgents: [] = [];
const threads = [{ id: "thread", taskGoal: "A thread", participantAgentIds: [] }] as unknown as RelaySession[];

function renderDirectory(enabled: boolean) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const view = renderHook(({ query }) => {
    const { localNodes, refreshLocalDaemonNodes } = useLocalDaemonNodes(enabled);
    // The same query -> node merge -> directory chain used by App.
    const visibleNodes = useMemo(() => mergeVisibleDaemonNodes(nodes, localNodes), [localNodes]);
    const runtimeNodes = useMemo(() => mergeThreadRuntimeNodes(nodes, localNodes), [localNodes]);
    const directory = useThreadDirectory({
      route: "main", myThreads: threads, projects, routedProjectId: null,
      threadQuery: query, tasks, visibleNodes, runtimeNodes, logicalAgents,
    });
    return { ...directory, refreshLocalDaemonNodes };
  }, { wrapper, initialProps: { query: "" } });
  return { ...view, client };
}

it("renders and filters threads when local-node discovery is disabled", () => {
  const view = renderDirectory(false);
  expect(view.result.current.directoryThreads).toHaveLength(1);
  view.rerender({ query: "missing" });
  expect(view.result.current.directoryThreads).toEqual([]);
  view.unmount();
  view.client.clear();
});

it("renders and filters threads while local-node discovery is pending", async () => {
  vi.mocked(listControlPanelDaemonNodes).mockReturnValue(new Promise(() => {}));
  const view = renderDirectory(true);
  await waitFor(() => expect(listControlPanelDaemonNodes).toHaveBeenCalled());
  view.rerender({ query: "A thread" });
  expect(view.result.current.directoryThreads).toHaveLength(1);
  view.unmount();
  view.client.clear();
});

it("keeps the directory usable after local-node discovery fails", async () => {
  vi.mocked(listControlPanelDaemonNodes).mockRejectedValue(new Error("Unavailable"));
  const view = renderDirectory(true);
  await waitFor(() => expect(view.client.getQueryState(["relay", "control-panel-nodes"])?.status).toBe("error"));
  view.rerender({ query: "A thread" });
  expect(view.result.current.directoryThreads).toHaveLength(1);
  view.unmount();
  view.client.clear();
});

it("applies discovered runs and keeps them visible if a later refresh fails", async () => {
  const node = {
    id: "computer", employeeId: "employee", status: "ready", online: true, stale: false,
    activeRuns: [{ sessionId: "thread", agent: "codex" }],
  } as ControlPanelDaemonNodeRecord;
  vi.mocked(listControlPanelDaemonNodes).mockResolvedValue({ nodes: [] });
  const view = renderDirectory(true);
  await waitFor(() => expect(view.client.getQueryState(["relay", "control-panel-nodes"])?.status).toBe("success"));
  expect(view.result.current.directoryThreads[0].runningAgent).toBeUndefined();

  vi.mocked(listControlPanelDaemonNodes).mockResolvedValue({ nodes: [node] });
  await act(async () => {
    expect(await view.result.current.refreshLocalDaemonNodes()).toEqual([node]);
  });
  await waitFor(() => expect(view.result.current.directoryThreads[0].runningAgent).toBe("codex"));

  vi.mocked(listControlPanelDaemonNodes).mockRejectedValue(new Error("Unavailable"));
  await act(async () => {
    expect(await view.result.current.refreshLocalDaemonNodes()).toEqual([]);
  });
  expect(view.result.current.directoryThreads[0].runningAgent).toBe("codex");
  view.unmount();
  view.client.clear();
});
