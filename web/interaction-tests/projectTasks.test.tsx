import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { ProjectTasks } from "../src/components/ProjectTasks";
import type { ProjectRecord, RelayTaskListItem } from "../src/types";

const mocks = vi.hoisted(() => ({ create: vi.fn(), update: vi.fn(), start: vi.fn(), open: vi.fn() }));
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
  <ProjectTasks project={{ ...project, ...override }} tasks={tasks} agents={[]} teams={[]}
    onOpenRecord={mocks.open} />,
);
beforeEach(() => { vi.clearAllMocks(); mocks.create.mockResolvedValue({}); mocks.update.mockResolvedValue({}); mocks.start.mockResolvedValue({}); });
it("scopes work and progress to live project tasks, including routine occurrences", () => {
  show([task("Ready"), task("Finished", { status: "done" }), task("Occurrence", { sourceRoutineId: "r" }),
    task("Other", { projectId: "other" }), task("Deleted", { deletedAt: "today" }), task("Routine", { isRoutine: true })]);
  // The record opens over the project rather than navigating to the backlog.
  fireEvent.click(screen.getByRole("button", { name: "Ready" }));
  expect(mocks.open).toHaveBeenCalledWith("Ready");
  expect(screen.queryByRole("button", { name: "Other" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Deleted" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Routine" })).toBeNull();
  expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("1");
  expect(screen.getByRole("progressbar").getAttribute("aria-valuemax")).toBe("3");
});
it("creates a task owned by the project and clears a successful draft", async () => {
  show();
  fireEvent.change(screen.getByRole("textbox", { name: "backlog.new_task" }), { target: { value: " Ship it " } });
  fireEvent.click(screen.getByRole("button", { name: "backlog.new_task" }));
  await waitFor(() => expect(mocks.create).toHaveBeenCalledWith({ title: "Ship it", projectId: "p", status: "backlog" }));
  await waitFor(() => expect((screen.getByRole("textbox", { name: "backlog.new_task" }) as HTMLInputElement).value).toBe(""));
});
it("preserves failed drafts and reports the error", async () => {
  mocks.create.mockRejectedValue(new Error("Offline")); show();
  fireEvent.change(screen.getByRole("textbox", { name: "backlog.new_task" }), { target: { value: "Keep me" } });
  fireEvent.click(screen.getByRole("button", { name: "backlog.new_task" }));
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect((screen.getByRole("textbox", { name: "backlog.new_task" }) as HTMLInputElement).value).toBe("Keep me");
});
it("keeps disabled and archived projects read-only but still readable", () => {
  const view = show([task("Ready")], { enabled: false });
  expect(screen.queryByRole("textbox", { name: "backlog.new_task" })).toBeNull();
  expect(screen.queryByRole("button", { name: "backlog.new_task" })).toBeNull();
  expect(screen.queryByRole("button", { name: "project.tasks_start" })).toBeNull();
  // The record is still reachable — read-only is not unreadable.
  expect(screen.getByRole("button", { name: "Ready" })).toBeTruthy();
  view.rerender(<ProjectTasks project={{ ...project, archivedAt: "today" }} tasks={[task("Ready")]}
    agents={[]} teams={[]} onOpenRecord={mocks.open} />);
  expect(screen.queryByRole("textbox", { name: "backlog.new_task" })).toBeNull();
  expect(screen.queryByRole("button", { name: "project.tasks_start" })).toBeNull();
});
it("uses real dispatch for starting work and permits acceptance only from review", async () => {
  show([task("Ready"), task("Check", { status: "review", startedAt: "today" }), task("Stuck", { status: "blocked", workflowStage: "assigned" })], { members: [{ agentId: "a", enabled: true } as any] });
  fireEvent.click(screen.getByRole("button", { name: "project.tasks_start" }));
  await waitFor(() => expect(mocks.start).toHaveBeenCalledWith({ taskId: "Ready" }));
  fireEvent.click(screen.getByRole("button", { name: "project.tasks_accept" }));
  await waitFor(() => expect(mocks.update).toHaveBeenCalledWith({ taskId: "Check", input: { status: "done" } }));
  expect(screen.getByText("backlog.statuses.blocked")).toBeTruthy();
});
it("names an assignee the roster cannot resolve instead of leaking its id", () => {
  render(
    <ProjectTasks
      project={project}
      tasks={[
        task("Ghosted", { assignedAgentId: "agent:missing" }),
        task("Teamed", { assignedTeamId: "team:missing" }),
      ]}
      agents={[]}
      teams={[]}
      onOpenRecord={mocks.open}
    />,
  );
  expect(screen.getByText("backlog.assignment_unavailable_agent")).toBeTruthy();
  expect(screen.getByText("backlog.assignment_unavailable_team")).toBeTruthy();
  expect(screen.queryByText(/agent:missing|team:missing/)).toBeNull();
});

it("keeps concurrent task actions locked independently until each settles", async () => {
  let finishFirst!: () => void;
  let failSecond!: (error: Error) => void;
  mocks.start
    .mockImplementationOnce(() => new Promise<void>((resolve) => { finishFirst = resolve; }))
    .mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { failSecond = reject; }));
  show([task("First"), task("Second")], { members: [{ agentId: "a", enabled: true } as any] });
  const firstCard = screen.getByRole("button", { name: "First" }).closest("tr")!;
  const secondCard = screen.getByRole("button", { name: "Second" }).closest("tr")!;
  const first = within(firstCard).getByRole("button", { name: "project.tasks_start" }) as HTMLButtonElement;
  const second = within(secondCard).getByRole("button", { name: "project.tasks_start" }) as HTMLButtonElement;
  fireEvent.click(first);
  expect(second.disabled).toBe(false);
  fireEvent.click(second);
  expect(first.disabled).toBe(true);
  expect(second.disabled).toBe(true);
  fireEvent.click(first);
  expect(mocks.start).toHaveBeenCalledTimes(2);

  await act(async () => { finishFirst(); });
  expect(first.disabled).toBe(false);
  expect(second.disabled).toBe(true);
  await act(async () => { failSecond(new Error("Second failed")); });
  expect(second.disabled).toBe(false);
  expect(within(secondCard).getByRole("alert").textContent).toBe("Second failed");
  expect(within(firstCard).queryByRole("alert")).toBeNull();
  fireEvent.click(second);
  await waitFor(() => expect(mocks.start).toHaveBeenCalledTimes(3));
  expect(within(secondCard).queryByRole("alert")).toBeNull();
});
