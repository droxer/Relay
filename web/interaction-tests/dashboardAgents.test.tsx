import { render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import { DashboardView } from "../src/components/admin/dashboard/DashboardView";
import type { NodeMetrics } from "../src/hooks/useNodeMetrics";
import { emptyDashboardWork } from "./dashboardWorkFixture";

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

function mockDashboardFetch(agents: () => Promise<Response>) {
  const requests = vi.fn(async (input: string) => {
    const { pathname } = new URL(input, "https://relay.test");
    if (pathname === "/api/v1/admin/dashboard/work") return Response.json(emptyDashboardWork);
    if (pathname === "/api/v1/admin/dashboard/agents") return agents();
    throw new Error(`Unexpected dashboard request: ${pathname}`);
  });
  vi.stubGlobal("fetch", requests);
  return requests;
}

it("loads one Agent count for the Dashboard tile", async () => {
  const requests = mockDashboardFetch(async () => Response.json({ count: 2 }));
  show();
  await waitFor(() => expect(agentTile().getByText("2")).toBeTruthy());
  expect(requests.mock.calls.map(([url]) => new URL(url, "https://relay.test").pathname).sort()).toEqual([
    "/api/v1/admin/dashboard/agents",
    "/api/v1/admin/dashboard/work",
  ]);
});

it("shows zero for an empty agent roster", async () => {
  mockDashboardFetch(async () => Response.json({ count: 0 }));
  show();
  await waitFor(() => expect(agentTile().getByText("0")).toBeTruthy());
});

it("shows an unavailable count while loading", () => {
  mockDashboardFetch(() => new Promise(() => {}));
  show();
  expect(agentTile().getByText("—")).toBeTruthy();
});

it("shows an unavailable count and error hint when the count query fails", async () => {
  mockDashboardFetch(() => Promise.reject(new Error("offline")));
  show();
  await waitFor(() => expect(agentTile().getByText("workspace.load_failed")).toBeTruthy());
  expect(agentTile().getByText("—")).toBeTruthy();
});
