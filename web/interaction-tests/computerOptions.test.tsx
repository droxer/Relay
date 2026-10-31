import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { expect, it, vi } from "vitest";
import { useComputerOptions } from "../src/hooks/useComputerOptions";
import { nodesAssignedToUser } from "../src/lib/computerNodes";
import { computerId, runtimesForComputer } from "../src/lib/createAgent";
import type { DaemonNodeMonitorRecord } from "../src/types";

const api = vi.hoisted(() => ({ listDaemonNodes: vi.fn(), listSandboxes: vi.fn() }));
vi.mock("../src/api", () => api);

function node(id: string, extra: Partial<DaemonNodeMonitorRecord> = {}): DaemonNodeMonitorRecord {
  return {
    id, userId: "alice", displayName: id, status: "ready",
    agents: { claude: "ready", codex: "unknown", pi: "unknown", kimi: "unknown" },
    online: true, stale: false, activeRuns: [], queuedCommandCount: 0,
    createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
    ...extra,
  };
}

it("offers the same two computers as My Computers when sandboxes retains a retired third", async () => {
  const visible = [node("laptop", { workspaceId: "mac" }), node("cloud", { managedNodeId: "cloud-1" })];
  api.listDaemonNodes.mockResolvedValue({ nodes: visible });
  api.listSandboxes.mockResolvedValue({ sandboxes: [...visible, node("removed", {
    retiredAt: "2026-01-02T00:00:00Z", status: "stopped",
  })] });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const { result, unmount } = renderHook(() => useComputerOptions("alice", true), { wrapper });
  await waitFor(() => expect(result.current.isLoading).toBe(false));
  expect(result.current.options.map((option) => option.computerId)).toEqual(
    nodesAssignedToUser(visible, "alice").map(computerId),
  );
  expect(result.current.options.map((option) => option.label)).toEqual(["laptop", "cloud"]);
  expect(runtimesForComputer(result.current.nodeLikes, "device:alice:mac")).toEqual(["claude"]);
  expect(api.listDaemonNodes).toHaveBeenCalled();
  unmount();
  client.clear();
});

it("uses the preferred daemon's name and runtimes while keeping offline computers and user scoping", async () => {
  api.listDaemonNodes.mockResolvedValue({ nodes: [
    node("old", { workspaceId: "mac", online: false, stale: true, status: "stopped" }),
    node("current", {
      workspaceId: "mac", displayName: "My laptop",
      agents: { claude: "unknown", codex: "ready", pi: "ready", kimi: "unknown" },
      disabledAgents: ["pi"],
    }),
    node("offline", { online: false, stale: true, status: "stopped" }),
    node("other-user", { userId: "bob" }),
  ] });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const { result, unmount } = renderHook(() => useComputerOptions("alice", true), { wrapper });
  await waitFor(() => expect(result.current.isLoading).toBe(false));
  expect(result.current.options.map((option) => option.label)).toEqual(["My laptop", "offline"]);
  expect(runtimesForComputer(result.current.nodeLikes, "device:alice:mac")).toEqual(["codex"]);
  unmount();
  client.clear();
});
