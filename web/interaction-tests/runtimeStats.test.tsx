import { render, screen, within } from "@testing-library/react";
import { expect, it } from "vitest";
import { RuntimeUsage, RuntimeInventory } from "../src/components/admin/dashboard/RuntimeStats";
import { runtimeInventory } from "../src/lib/runtimeInventory";
import type { ControlPanelDaemonNodeRecord } from "../src/types";
import type { TokenUsageState } from "../src/hooks/useTokenUsage";

const node = (overrides: object) => ({ status: "ready", online: true, stale: false, agents: { codex: "ready" }, ...overrides } as ControlPanelDaemonNodeRecord);
it("counts installations, excludes offline and disabled readiness, and separates failed checks", () => {
  const rows = runtimeInventory([
    node({}), node({ online: false }), node({ disabledAgents: ["codex"] }),
    node({ agents: { codex: "failed", kimi: "unresponsive", claude: "unavailable" } }),
  ]);
  expect(rows.find(row => row.agent === "codex")).toEqual({ agent: "codex", installed: 4, ready: 1, failed: 1 });
  expect(rows.find(row => row.agent === "kimi")?.failed).toBe(1);
  expect(rows.find(row => row.agent === "claude")?.installed).toBe(0);
});
it("shows missing token reporting as unknown, including partial coverage", () => {
  render(<RuntimeUsage snapshot={{ runtimes: [
    { agent: "codex", runs: 4, reportedRuns: 3, fresh: 123, cacheRead: 45 },
    { agent: "kimi", runs: 2, reportedRuns: 0, fresh: 0, cacheRead: 0 },
  ] } as TokenUsageState} />);
  const codex = screen.getByRole("row", { name: /Codex/ });
  expect(within(codex).getByText("123")).toBeTruthy();
  expect(within(codex).getByText("admin.v2.dash_runtime_coverage")).toBeTruthy();
  expect(within(screen.getByRole("row", { name: /Kimi/ })).getAllByText("—")).toHaveLength(2);
});
it("handles loading, errors and no runtime history", () => {
  const { rerender } = render(<RuntimeUsage snapshot={{ isLoading: true } as TokenUsageState} />);
  expect(screen.getByText("admin.v2.dash_loading")).toBeTruthy();
  rerender(<RuntimeUsage snapshot={{ isError: true } as TokenUsageState} />);
  expect(screen.getByText("workspace.load_failed")).toBeTruthy();
  rerender(<RuntimeUsage snapshot={{ runtimes: [] } as unknown as TokenUsageState} />);
  expect(screen.getByText("admin.v2.dash_runtime_empty")).toBeTruthy();
});
it("labels inventory as current, independent of the historical range", () => {
  render(<RuntimeInventory nodes={[]} />);
  expect(screen.getByText("admin.v2.dash_runtime_inventory_hint")).toBeTruthy();
  expect(screen.getAllByRole("row")).toHaveLength(6);
});
it("does not claim zero installations while the inventory is loading or failed", () => {
  const { rerender } = render(<RuntimeInventory nodes={[]} loading />);
  expect(screen.getByRole("status").textContent).toBe("admin.v2.dash_loading");
  expect(screen.queryByRole("table")).toBeNull();
  rerender(<RuntimeInventory nodes={[]} error="network" />);
  expect(screen.getByRole("alert").textContent).toBe("workspace.load_failed");
  expect(screen.queryByRole("table")).toBeNull();
});
