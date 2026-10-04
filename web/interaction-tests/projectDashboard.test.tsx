import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { expect, it, vi } from "vitest";
import { ProjectDashboard } from "../src/components/ProjectDashboard";
import type { RelayTaskListItem } from "../src/types";

const FLOW_POLICY_KEY = ["task-flow-policy"] as const;

const task = (overrides: Partial<RelayTaskListItem>): RelayTaskListItem => ({
  id: "t",
  title: "Task",
  status: "backlog",
  priority: "normal",
  createdAt: "2026-09-01T00:00:00Z",
  updatedAt: "2026-09-01T00:00:00Z",
  ...overrides,
} as RelayTaskListItem);

function renderDashboard(tasks: RelayTaskListItem[], client = new QueryClient()) {
  const onOpenRecord = vi.fn();
  const onOpenBoard = vi.fn();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const view = render(
    <ProjectDashboard tasks={tasks} onOpenRecord={onOpenRecord} onOpenBoard={onOpenBoard} />,
    { wrapper },
  );
  return { ...view, client, onOpenRecord, onOpenBoard };
}

const tileOf = (eyebrow: string) => screen.getByText(eyebrow).closest(".adm-dash-tile")!;

it("subscribes to the task flow policy cache without requiring a fetch function", async () => {
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const { client } = renderDashboard([task({ id: "a" })]);
  // No policy cached yet: the work-in-progress tile carries no limit hint.
  expect(tileOf("backlog.metric_active").querySelector(".adm-dash-tile-hint")).toBeNull();

  act(() => {
    client.setQueryData(FLOW_POLICY_KEY, { wipLimit: 5, scope: "employee" });
  });

  await waitFor(() => {
    expect(tileOf("backlog.metric_active").querySelector(".adm-dash-tile-hint")).not.toBeNull();
  });
  expect(screen.getByText("backlog.metric_active").nextElementSibling?.textContent).toBe("0");
  expect(consoleError).not.toHaveBeenCalledWith(expect.stringContaining("No queryFn was passed"));
  client.clear();
});

it("shows an empty note and the way to the board when the project has no issues", () => {
  const { container, onOpenBoard } = renderDashboard([]);
  expect(screen.getByText("project.dashboard_empty")).toBeTruthy();
  expect(container.querySelector(".adm-dash-kpis")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "project.dashboard_open_board" }));
  expect(onOpenBoard).toHaveBeenCalledOnce();
});

it("tones the blocked tile only while something is blocked", () => {
  renderDashboard([task({ id: "a", status: "blocked" })]);
  expect(tileOf("backlog.metric_blocked").classList.contains("tone-bad")).toBe(true);
  expect(tileOf("backlog.metric_overdue").classList.contains("tone-bad")).toBe(false);
});

it("opens an issue that needs attention from the list", () => {
  const { onOpenRecord } = renderDashboard([
    task({ id: "fine", title: "Fine" }),
    task({ id: "stuck", title: "Stuck issue", status: "blocked" }),
  ]);
  expect(screen.queryByRole("button", { name: /Fine/ })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /Stuck issue/ }));
  expect(onOpenRecord).toHaveBeenCalledWith("stuck");
});

it("says so when nothing needs attention", () => {
  renderDashboard([task({ id: "a" })]);
  expect(screen.getByText("project.dashboard_attention_empty")).toBeTruthy();
});
