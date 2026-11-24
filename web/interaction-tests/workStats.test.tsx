import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { WorkStatsRow } from "../src/components/admin/dashboard/WorkStats";
import type { DashboardWorkResponse } from "../src/api";

const SAMPLE: DashboardWorkResponse = {
  projects: {
    total: 5,
    enabled: 4,
    disabled: 1,
    archived: 2,
    created: 2,
    activeInRange: 3,
  },
  tasks: {
    total: 18,
    open: 7,
    created: 9,
    done: 4,
    inProgress: 2,
    blocked: 1,
    backlog: 1,
    cancelled: 1,
    inProjects: 6,
    standalone: 3,
    statusCounts: { done: 4, running: 2, blocked: 1, backlog: 1, cancelled: 1 },
  },
  conversations: {
    total: 15,
    chats: 8,
    totalChats: 24,
    projectChats: 5,
    standaloneChats: 3,
    taskRuns: 5,
    automationRuns: 2,
  },
};

it("renders project, task, and conversation breakdown cards", () => {
  render(<WorkStatsRow data={SAMPLE} loading={false} />);
  expect(screen.getByRole("heading", { name: "admin.v2.dash_work_projects_title" })).toBeTruthy();
  expect(screen.getByRole("heading", { name: "admin.v2.dash_work_tasks_title" })).toBeTruthy();
  expect(screen.getByRole("heading", { name: "admin.v2.dash_work_conversations_title" })).toBeTruthy();
  expect(screen.getByText("admin.v2.dash_work_projects_active")).toBeTruthy();
  expect(screen.getByText("admin.v2.dash_work_tasks_blocked")).toBeTruthy();
  expect(screen.getByText("admin.v2.dash_work_conversations_project")).toBeTruthy();
  expect(screen.getByText("admin.v2.dash_work_conversations_task_runs")).toBeTruthy();
});

it("shows loading and error states without claiming zero counts", () => {
  const { rerender } = render(<WorkStatsRow data={SAMPLE} loading />);
  expect(screen.getAllByRole("status")).toHaveLength(3);
  expect(screen.queryByText("admin.v2.dash_work_projects_active")).toBeNull();

  rerender(<WorkStatsRow data={SAMPLE} loading={false} error="network error" />);
  expect(screen.getAllByRole("alert")).toHaveLength(3);
  expect(screen.queryByText("admin.v2.dash_work_tasks_done")).toBeNull();
});
