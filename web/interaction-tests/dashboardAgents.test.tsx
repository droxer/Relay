import { render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import { DashboardView } from "../src/components/admin/dashboard/DashboardView";
import { listControlPanelAgents } from "../src/api";
import type { NodeMetrics } from "../src/hooks/useNodeMetrics";

vi.mock("../src/api", () => ({ listControlPanelAgents: vi.fn() }));
vi.mock("../src/hooks/useDashboardSessions", () => ({
  useDashboardSessions: () => ({ isLoading: false, error: null, data: {
    total: 0, last24h: 0, last7d: 0, dailyCounts: [], topUsers: [],
  } }),
}));
vi.mock("../src/hooks/useTokenUsage", () => ({
  useTokenUsage: () => ({ available: false, isError: false }),
}));

function show() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}>
    <DashboardView nodes={[]} users={[]} metrics={{ total: 0, queued: 0 } as NodeMetrics} onManageNodes={() => {}} />
  </QueryClientProvider>);
}

function agentTile() {
  return within(screen.getByText("admin.v2.dash_kpi_agents").closest(".adm-dash-tile") as HTMLElement);
}

it("counts agents across users and excludes deleted agents", async () => {
  vi.mocked(listControlPanelAgents).mockResolvedValue({ agents: [
    { id: "a", supervisorUserId: "one" },
    { id: "b", supervisorUserId: "two" },
    { id: "deleted", deletedAt: "2026-11-01T00:00:00Z" },
  ] } as Awaited<ReturnType<typeof listControlPanelAgents>>);
  show();
  await waitFor(() => expect(agentTile().getByText("2")).toBeTruthy());
});

it("shows zero for an empty agent roster", async () => {
  vi.mocked(listControlPanelAgents).mockResolvedValue({ agents: [] });
  show();
  await waitFor(() => expect(agentTile().getByText("0")).toBeTruthy());
});

it("shows an unavailable count while loading", () => {
  vi.mocked(listControlPanelAgents).mockReturnValue(new Promise(() => {}));
  show();
  expect(agentTile().getByText("—")).toBeTruthy();
});

it("shows an unavailable count and error hint when the roster fails", async () => {
  vi.mocked(listControlPanelAgents).mockRejectedValue(new Error("offline"));
  show();
  await waitFor(() => expect(agentTile().getByText("workspace.load_failed")).toBeTruthy());
  expect(agentTile().getByText("—")).toBeTruthy();
});
