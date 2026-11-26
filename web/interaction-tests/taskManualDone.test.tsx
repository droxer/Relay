import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { DialogProvider } from "@/components/ui/DialogProvider";
import { TaskRecordView } from "../src/components/task-record/TaskRecordView";
import { TaskReviewProvider } from "../src/components/task-record/TaskReviewProvider";
import type { RelayTask } from "../src/types";

const { getTask, updateTask, listTaskRuns, listTaskArtifacts, listTaskEvents, getTaskReview } = vi.hoisted(() => ({
  getTask: vi.fn(),
  updateTask: vi.fn(),
  listTaskRuns: vi.fn(async () => ({ runs: [] })),
  listTaskArtifacts: vi.fn(async () => ({ artifacts: [] })),
  listTaskEvents: vi.fn(async () => ({ events: [] })),
  getTaskReview: vi.fn(),
}));

vi.mock("../src/api", async (original) => ({
  ...await original<typeof import("../src/api")>(),
  getTask,
  updateTask,
  listTaskRuns,
  listTaskArtifacts,
  listTaskEvents,
  getTaskReview,
  listTaskWorkspaceFiles: vi.fn(async () => ({ files: [] })),
  taskWorkspaceStatus: vi.fn(async () => ({ waiting: false })),
  listTeams: vi.fn(async () => ({ teams: [] })),
  listUserAgents: vi.fn(async () => ({ agents: [] })),
  listControlPanelUsers: vi.fn(async () => ({ users: [] })),
  listProjects: vi.fn(async () => ({ projects: [] })),
  getProject: vi.fn(async () => ({ project: { id: "proj-1", name: "Relay", enabled: true, archivedAt: null, members: [] } })),
}));

const USER = { id: "u-1", username: "fei", role: "user", userId: "fei" } as const;

function makeTask(overrides: Partial<RelayTask>): RelayTask {
  return {
    id: "T-1",
    title: "Ship manual completion",
    description: "Verify completion from any state.",
    priority: "normal",
    status: "running",
    workflowStage: "running",
    isRoutine: false,
    ownerUserId: "fei",
    assigneeUserId: "fei",
    assignedAgentId: "agent-1",
    linkedSessionIds: ["sess-1"],
    createdAt: "2026-11-26T00:00:00Z",
    updatedAt: "2026-11-26T00:05:00Z",
    events: [],
    activity: [],
    ...overrides,
  } as RelayTask;
}

function renderTaskRecord(task: RelayTask, listTasks: RelayTask[] = []) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <DialogProvider>
        <TaskReviewProvider>
          <TaskRecordView
            taskId={task.id}
            currentUser={USER}
            tasks={listTasks}
            onEdit={vi.fn()}
            onOpenThread={vi.fn()}
            onOpenRecord={vi.fn()}
            onDeleted={vi.fn()}
          />
        </TaskReviewProvider>
      </DialogProvider>
    </QueryClientProvider>,
  );
  return { client, ...view };
}

beforeEach(() => {
  vi.clearAllMocks();
});

it("does not patch a running project task when confirmation is cancelled", async () => {
  const running = makeTask({ id: "T-proj-cancel", projectId: "proj-1", status: "running", workflowStage: "running" });
  getTask.mockResolvedValue(running);

  const user = userEvent.setup();
  renderTaskRecord(running, [running]);

  const markDoneButton = await screen.findByRole("button", { name: "decision.mark_done" });
  expect(screen.getByRole("button", { name: "record.cancel_run" })).toBeTruthy();

  await user.click(markDoneButton);
  expect(await screen.findByText("record.mark_done_confirm")).toBeTruthy();
  const modal = document.querySelector(".dialog-modal") as HTMLElement;
  await user.click(within(modal).getByRole("button", { name: "dialog.cancel" }));
  await waitFor(() => expect(screen.queryByText("record.mark_done_confirm")).toBeNull());
  expect(updateTask).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "decision.mark_done" })).toBeTruthy();
});

it("confirms, patches, and visibly completes a running project task", async () => {
  const running = makeTask({ id: "T-proj-run", projectId: "proj-1", status: "running", workflowStage: "running" });
  const done = { ...running, status: "done", workflowStage: "done", updatedAt: "2026-11-26T00:06:00Z" } as RelayTask;
  let current = running;
  getTask.mockImplementation(async () => current);
  updateTask.mockImplementation(async () => {
    current = done;
    return done;
  });

  const user = userEvent.setup();
  renderTaskRecord(running, [running]);

  await user.click(await screen.findByRole("button", { name: "decision.mark_done" }));
  expect(await screen.findByText("record.mark_done_confirm")).toBeTruthy();
  const confirmModal = document.querySelector(".dialog-modal") as HTMLElement;
  await user.click(within(confirmModal).getByRole("button", { name: "decision.mark_done" }));

  await waitFor(() => expect(updateTask).toHaveBeenCalledWith("T-proj-run", { status: "done" }));
  await waitFor(() => expect(screen.queryByRole("button", { name: "decision.mark_done" })).toBeNull());
  expect(screen.queryByRole("button", { name: "record.cancel_run" })).toBeNull();
  expect(screen.getByText("backlog.statuses.done")).toBeTruthy();
});

it("completes a cancelled standalone task directly on its record route with no list row", async () => {
  const cancelled = makeTask({
    id: "T-solo-cancel",
    projectId: undefined,
    status: "cancelled",
    workflowStage: "cancelled",
    linkedSessionIds: [],
  });
  const done = { ...cancelled, status: "done", workflowStage: "done", updatedAt: "2026-11-26T00:06:00Z" } as RelayTask;
  let current = cancelled;
  getTask.mockImplementation(async () => current);
  updateTask.mockImplementation(async () => {
    current = done;
    return done;
  });

  const user = userEvent.setup();
  // Empty `tasks` mimics navigating directly to `/tasks/T-solo-cancel` without a cached list row.
  renderTaskRecord(cancelled, []);

  await user.click(await screen.findByRole("button", { name: "decision.mark_done" }));
  expect(await screen.findByText("record.mark_done_confirm")).toBeTruthy();
  const modal = document.querySelector(".dialog-modal") as HTMLElement;
  await user.click(within(modal).getByRole("button", { name: "decision.mark_done" }));

  await waitFor(() => expect(updateTask).toHaveBeenCalledWith("T-solo-cancel", { status: "done" }));
  await waitFor(() => expect(screen.queryByRole("button", { name: "decision.mark_done" })).toBeNull());
  expect(screen.getByText("backlog.statuses.done")).toBeTruthy();
});

it("keeps review tasks on the review acceptance dialog instead of the plain confirmation", async () => {
  const reviewTask = makeTask({ id: "T-review", projectId: "proj-1", status: "review", workflowStage: "review" });
  getTask.mockResolvedValue(reviewTask);
  getTaskReview.mockResolvedValue({
    taskId: reviewTask.id,
    revision: "a".repeat(64),
    status: "review",
    canAccept: true,
    goal: "Review goal summary",
    criteria: [],
    reports: [],
    artifacts: [],
  });

  const user = userEvent.setup();
  renderTaskRecord(reviewTask, []);

  await user.click(await screen.findByRole("button", { name: "decision.mark_done" }));
  await waitFor(() => expect(document.querySelector(".task-review-dialog")).toBeTruthy());
  expect(screen.queryByText("record.mark_done_confirm")).toBeNull();
  await waitFor(() => expect(getTaskReview).toHaveBeenCalledWith("T-review", expect.anything()));
  expect(updateTask).not.toHaveBeenCalled();
});
