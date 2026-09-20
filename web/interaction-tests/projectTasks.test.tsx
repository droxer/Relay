import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { ProjectTasks } from "../src/components/ProjectTasks";
import type { ProjectRecord, RelayTaskListItem } from "../src/types";

const mocks = vi.hoisted(() => ({ create: vi.fn(), update: vi.fn(), start: vi.fn() }));
vi.mock("../src/hooks/useRelayMutations", () => ({ useRelayMutations: () => ({
  createTaskMutation: { mutateAsync: mocks.create },
  updateTaskMutation: { mutateAsync: mocks.update },
  startTaskMutation: { mutateAsync: mocks.start },
}) }));
const project = { id: "p", name: "Launch", enabled: true, members: [], leadAgentId: null } as unknown as ProjectRecord;
const task = (id: string, overrides: Partial<RelayTaskListItem> = {}): RelayTaskListItem => ({
  id, title: id, description: "", priority: "normal", status: "backlog", projectId: "p",
  isRoutine: false, routineEnabled: false, linkedSessionIds: [],
  createdAt: "2026-09-01", updatedAt: "2026-09-01", ...overrides,
});
const show = (tasks: RelayTaskListItem[] = [], override: Partial<ProjectRecord> = {}) => render(
  <ProjectTasks project={{ ...project, ...override }} tasks={tasks} agents={[]} />,
);
beforeEach(() => { vi.clearAllMocks(); mocks.create.mockResolvedValue({}); mocks.update.mockResolvedValue({}); mocks.start.mockResolvedValue({}); });
it("scopes work and progress to live project tasks, including routine occurrences", () => {
  show([task("Ready"), task("Finished", { status: "done" }), task("Occurrence", { sourceRoutineId: "r" }),
    task("Other", { projectId: "other" }), task("Deleted", { deletedAt: "today" }), task("Routine", { isRoutine: true })]);
  expect(screen.getByRole("link", { name: "Ready" }).getAttribute("href")).toBe("/backlog/Ready");
  expect(screen.queryByRole("link", { name: "Other" })).toBeNull();
  expect(screen.queryByRole("link", { name: "Deleted" })).toBeNull();
  expect(screen.queryByRole("link", { name: "Routine" })).toBeNull();
  expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("1");
  expect(screen.getByRole("progressbar").getAttribute("aria-valuemax")).toBe("3");
});
it("creates a task owned by the project and clears a successful draft", async () => {
  show();
  fireEvent.change(screen.getByRole("textbox", { name: "backlog.new_task" }), { target: { value: " Ship it " } });
  fireEvent.click(screen.getByRole("button", { name: "backlog.new_task" }));
  await waitFor(() => expect(mocks.create).toHaveBeenCalledWith({ title: "Ship it", projectId: "p", status: "backlog" }));
  await waitFor(() => expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe(""));
});
it("preserves failed drafts and reports the error", async () => {
  mocks.create.mockRejectedValue(new Error("Offline")); show();
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "Keep me" } });
  fireEvent.click(screen.getByRole("button", { name: "backlog.new_task" }));
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("Keep me");
});
it("keeps disabled and archived projects read-only", () => {
  const view = show([task("Ready")], { enabled: false });
  expect(screen.queryByRole("textbox")).toBeNull();
  expect(screen.queryByRole("button")).toBeNull();
  view.rerender(<ProjectTasks project={{ ...project, archivedAt: "today" }} tasks={[task("Ready")]} agents={[]} />);
  expect(screen.queryByRole("textbox")).toBeNull();
});
it("uses real dispatch for starting work and permits acceptance only from review", async () => {
  show([task("Ready"), task("Check", { status: "review", startedAt: "today" }), task("Stuck", { status: "blocked", workflowStage: "assigned" })], { members: [{ agentId: "a", enabled: true } as any] });
  fireEvent.click(screen.getByRole("button", { name: "project.tasks_start" }));
  await waitFor(() => expect(mocks.start).toHaveBeenCalledWith({ taskId: "Ready" }));
  fireEvent.click(screen.getByRole("button", { name: "project.tasks_accept" }));
  await waitFor(() => expect(mocks.update).toHaveBeenCalledWith({ taskId: "Check", input: { status: "done" } }));
  expect(screen.getByText("backlog.statuses.blocked")).toBeTruthy();
});
