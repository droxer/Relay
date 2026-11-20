import { render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import { DashboardView } from "../src/components/admin/dashboard/DashboardView";
import type { NodeMetrics } from "../src/hooks/useNodeMetrics";

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
    <DashboardView nodes={[]} metrics={{ total: 0, queued: 0 } as NodeMetrics} onManageNodes={() => {}} />
  </QueryClientProvider>);
}

function agentTile() {
  return within(screen.getByText("admin.v2.dash_kpi_agents").closest(".adm-dash-tile") as HTMLElement);
}

it("loads one Agent count for the Dashboard tile", async () => {
  const requests = vi.fn(async (_input: string) => Response.json({ count: 2 }));
  vi.stubGlobal("fetch", requests);
  show();
  await waitFor(() => expect(agentTile().getByText("2")).toBeTruthy());
  expect(requests.mock.calls.map(([url]) => new URL(url, "https://relay.test").pathname)).toEqual([
    "/api/v1/admin/dashboard/agents",
  ]);
});

it("shows zero for an empty agent roster", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ count: 0 })));
  show();
  await waitFor(() => expect(agentTile().getByText("0")).toBeTruthy());
});

it("shows an unavailable count while loading", () => {
  vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
  show();
  expect(agentTile().getByText("—")).toBeTruthy();
});

it("shows an unavailable count and error hint when the count query fails", async () => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
  show();
  await waitFor(() => expect(agentTile().getByText("workspace.load_failed")).toBeTruthy());
  expect(agentTile().getByText("—")).toBeTruthy();
});
