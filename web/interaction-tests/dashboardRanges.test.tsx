import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import { DashboardView } from "../src/components/admin/dashboard/DashboardView";
import { getDashboardSessions, getDashboardTokens } from "../src/api";
import type { NodeMetrics } from "../src/hooks/useNodeMetrics";

vi.mock("../src/api", () => ({
  listControlPanelAgents: vi.fn(async () => ({ agents: [] })),
  getDashboardSessions: vi.fn(async () => ({ total: 0, last24h: 0, last7d: 0, statusCounts: {}, dailyCounts: [], topUsers: [] })),
  getDashboardTokens: vi.fn(async () => ({ available: false, daily: [] })),
}));

function show() {
  vi.mocked(getDashboardSessions).mockClear();
  vi.mocked(getDashboardTokens).mockClear();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}>
    <DashboardView nodes={[]} users={[]} metrics={{ total: 0, queued: 0 } as NodeMetrics} onManageNodes={() => {}} />
  </QueryClientProvider>);
}

it("defaults to seven days and changes both historical queries together", async () => {
  show();
  expect((screen.getByLabelText("admin.v2.dash_range") as HTMLSelectElement).value).toBe("7d");
  await waitFor(() => expect(getDashboardSessions).toHaveBeenCalledTimes(1));
  const initial = vi.mocked(getDashboardSessions).mock.calls[0][1]!;
  expect((Date.parse(initial.end) - Date.parse(initial.start)) / 86400000).toBe(6);
  fireEvent.change(screen.getByLabelText("admin.v2.dash_range"), { target: { value: "30d" } });
  await waitFor(() => expect(getDashboardSessions).toHaveBeenCalledTimes(2));
  const range = vi.mocked(getDashboardSessions).mock.calls[1][1]!;
  expect((Date.parse(range.end) - Date.parse(range.start)) / 86400000).toBe(29);
  expect(vi.mocked(getDashboardTokens).mock.calls.at(-1)?.[2]).toEqual(range);
});

it("uses the previous calendar month and only applies a valid custom range on submit", async () => {
  show();
  fireEvent.change(screen.getByLabelText("admin.v2.dash_range"), { target: { value: "month" } });
  await waitFor(() => expect(getDashboardSessions).toHaveBeenCalledTimes(2));
  const month = vi.mocked(getDashboardSessions).mock.calls[1][1]!;
  expect(month.start.endsWith("-01")).toBe(true);
  expect(new Date(`${month.end}T12:00:00`).getMonth()).toBe((new Date().getMonth() + 11) % 12);
  fireEvent.change(screen.getByLabelText("admin.v2.dash_range"), { target: { value: "custom" } });
  fireEvent.change(screen.getByLabelText("admin.v2.dash_range_start"), { target: { value: "2026-01-10" } });
  fireEvent.change(screen.getByLabelText("admin.v2.dash_range_end"), { target: { value: "2026-01-09" } });
  expect((screen.getByRole("button", { name: "admin.v2.dash_range_apply" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText("admin.v2.dash_range_end"), { target: { value: "2026-01-11" } });
  expect(getDashboardSessions).toHaveBeenCalledTimes(2);
  fireEvent.click(screen.getByRole("button", { name: "admin.v2.dash_range_apply" }));
  await waitFor(() => expect(getDashboardSessions).toHaveBeenCalledTimes(3));
  expect(vi.mocked(getDashboardSessions).mock.calls[2][1]).toEqual({ start: "2026-01-10", end: "2026-01-11" });
  expect(vi.mocked(getDashboardTokens).mock.calls.at(-1)?.[2]).toEqual({ start: "2026-01-10", end: "2026-01-11" });
});

it("handles month boundaries, leap years, and custom range limits", async () => {
  const { dashboardPresetRange, validDashboardRange } = await import("../src/lib/dashboardRange");
  expect(dashboardPresetRange("month", new Date(2026, 0, 15))).toEqual({ start: "2025-12-01", end: "2025-12-31" });
  expect(dashboardPresetRange("month", new Date(2024, 2, 15))).toEqual({ start: "2024-02-01", end: "2024-02-29" });
  expect(dashboardPresetRange("7d", new Date(2026, 0, 3))).toEqual({ start: "2025-12-28", end: "2026-01-03" });
  expect(validDashboardRange({ start: "2026-01-01", end: "2026-01-01" })).toBe(true);
  expect(validDashboardRange({ start: "2026-01-01", end: "2027-01-01" })).toBe(true);
  expect(validDashboardRange({ start: "2026-01-01", end: "2027-01-02" })).toBe(false);
  expect(validDashboardRange({ start: "", end: "2026-01-01" })).toBe(false);
});


it("keeps loading token usage unavailable instead of showing zero or an empty result", async () => {
  vi.mocked(getDashboardTokens).mockImplementationOnce(() => new Promise(() => {}));
  show();
  const tile = screen.getByText("admin.v2.dash_kpi_tokens").closest(".adm-dash-tile")!;
  expect(tile.textContent).toContain("—");
  expect(screen.queryByText("admin.v2.dash_tokens_empty")).toBeNull();
  await waitFor(() => expect(getDashboardTokens).toHaveBeenCalledTimes(1));
});

it("describes chart results using the selected range in both languages", async () => {
  const en = (await import("../src/i18n/locales/en/translation.json")).default.admin.v2;
  const zh = (await import("../src/i18n/locales/zh-CN/translation.json")).default.admin.v2;
  expect(en.dash_sessions_title).toBe("Threads");
  expect(en.dash_sessions_empty).toBe("No threads in the selected range.");
  expect(zh.dash_sessions_title).toBe("对话趋势");
  expect(zh.dash_sessions_empty).toBe("所选范围内暂无对话。");
});
