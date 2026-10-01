import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useMemo, type ReactNode } from "react";
import { expect, it, vi } from "vitest";
import { listControlPanelDaemonNodes } from "../src/api";
import { useLocalDaemonNodes } from "../src/hooks/useLocalDaemonNodes";
import { useThreadDirectory } from "../src/hooks/useThreadDirectory";
import { mergeThreadRuntimeNodes, mergeVisibleDaemonNodes } from "../src/lib/daemonNodes";
import type { DaemonNodeMonitorRecord, RelaySession } from "../src/types";

vi.mock("../src/api", () => ({ listControlPanelDaemonNodes: vi.fn() }));

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
    const { localNodes } = useLocalDaemonNodes(enabled);
    // The same query -> node merge -> directory chain used by App.
    const visibleNodes = useMemo(() => mergeVisibleDaemonNodes(nodes, localNodes), [localNodes]);
    const runtimeNodes = useMemo(() => mergeThreadRuntimeNodes(nodes, localNodes), [localNodes]);
    return useThreadDirectory({
      route: "main", myThreads: threads, projects, routedProjectId: null,
      threadQuery: query, tasks, visibleNodes, runtimeNodes, logicalAgents,
    });
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
  act(() => view.rerender({ query: "A thread" }));
  expect(view.result.current.directoryThreads).toHaveLength(1);
  view.unmount();
  view.client.clear();
});
