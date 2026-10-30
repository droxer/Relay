import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { RoutinesPage } from "../src/components/RoutinesPage";
import type { CurrentUser, ProjectRecord, RelayTaskListItem } from "../src/types";

const { create, table } = vi.hoisted(() => ({ create: vi.fn(), table: vi.fn() }));
vi.mock("../src/hooks/useUserAgents", () => ({ useUserAgents: () => ({ agents: [] }) }));
vi.mock("../src/hooks/useTeams", () => ({ useTeams: () => ({ teams: [] }) }));
vi.mock("../src/hooks/useRelayMutations", () => ({ useRelayMutations: () => ({
  createTaskMutation: { mutateAsync: create }, startTaskMutation: {}, updateTaskMutation: {},
  deleteTaskMutation: {}, deleteTasksMutation: {},
}) }));
vi.mock("../src/components/ui/DialogProvider", () => ({ useDialogs: () => ({ announce: vi.fn(), confirm: vi.fn() }) }));
vi.mock("../src/hooks/useUnsavedChangesGuard", () => ({ useUnsavedChangesGuard: () => vi.fn(async () => true) }));
vi.mock("../src/components/ProjectDrawer", () => ({ ProjectDrawer: () => null }));
vi.mock("../src/components/task-board/RoutineRecords", () => ({ RoutineTable: (props: unknown) => { table(props); return null; } }));
vi.mock("../src/components/task-board/TaskDrawer", () => ({ TaskDrawer: ({ form, onChange, onSubmit, projectChoice }: any) => (
  <form onSubmit={onSubmit} aria-label="automation-draft" data-project={form.projectId} data-project-choice={projectChoice}>
    <input aria-label="Title" value={form.title} onChange={(event) => onChange({ ...form, title: event.target.value })} />
    <button type="submit">Save</button>
  </form>
) }));
const project = { id: "p", name: "Launch", enabled: true, members: [] } as unknown as ProjectRecord;
function page(readOnly = false, tasks: RelayTaskListItem[] = []) {
  render(<QueryClientProvider client={new QueryClient()}><RoutinesPage projectId="p" projects={[project]}
    readOnly={readOnly} tasks={tasks} nodes={[]} currentUser={{ userId: "u", username: "u" } as CurrentUser}
    onOpenRecord={vi.fn()} onOpenThread={vi.fn()} /></QueryClientProvider>);
}
beforeEach(() => { create.mockReset(); table.mockClear(); window.history.replaceState({}, "", "/projects/p?tab=automations"); });
it("creates an automation in the current project with the project fixed", async () => {
  create.mockResolvedValue({ id: "r" });
  page();
  fireEvent.click(screen.getAllByRole("button", { name: "routine.new" })[0]);
  expect(screen.getByRole("form").dataset).toMatchObject({ project: "p", projectChoice: "locked" });
  fireEvent.change(screen.getByRole("textbox", { name: "Title" }), { target: { value: "Weekly review" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(create).toHaveBeenCalledWith(expect.objectContaining({ projectId: "p", title: "Weekly review", isRoutine: true })));
});
it("offers no creation action for a closed project", () => {
  page(true);
  expect(screen.queryByRole("button", { name: "routine.new" })).toBeNull();
});
it("lists only live automations in the current project", () => {
  const routine = (id: string, projectId: string, extra = {}) => ({ id, projectId, isRoutine: true, title: id, tags: [], routineTriggers: [], ...extra }) as RelayTaskListItem;
  page(false, [routine("mine", "p"), routine("other", "q"), routine("deleted", "p", { deletedAt: "today" })]);
  expect(table.mock.lastCall?.[0].rows.map((task: RelayTaskListItem) => task.id)).toEqual(["mine"]);
});

it("keeps the project draft available when saving fails", async () => {
  create.mockRejectedValue(new Error("Unavailable"));
  page();
  fireEvent.click(screen.getAllByRole("button", { name: "routine.new" })[0]);
  fireEvent.change(screen.getByRole("textbox", { name: "Title" }), { target: { value: "Retry me" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(create).toHaveBeenCalled());
  expect(screen.getByRole("form").dataset.project).toBe("p");
  expect((screen.getByRole("textbox", { name: "Title" }) as HTMLInputElement).value).toBe("Retry me");
});
