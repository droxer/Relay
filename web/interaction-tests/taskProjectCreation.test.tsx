import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { TaskDrawer } from "../src/components/task-board/TaskDrawer";
import { emptyBacklogForm, emptyRoutineForm, type TaskBoardFormState } from "../src/lib/taskBoardForm";
import type { AgentTeam, CurrentUser, ProjectRecord } from "../src/types";

vi.mock("../src/api", async (original) => ({
  ...(await original<typeof import("../src/api")>()),
  getMe: vi.fn(async () => ({ authenticated: true })),
  previewSchedule: vi.fn(async () => ({ summary: "", next: [] })),
}));
vi.mock("@/components/ui/Drawer", () => ({ Drawer: ({ children, footer }: any) => <>{children}{footer}</> }));
vi.mock("../src/components/assignment/AssignmentField", () => ({ AssignmentField: ({ agents, teams }: any) => <div data-testid="assignment-options">{agents.map((a: any) => a.displayName).join(",")}{teams.map((a: any) => a.name).join(",")}</div> }));
const user = { userId: "u", username: "u" } as CurrentUser;
const projects = [
  { id: "p", name: "Launch", enabled: true, members: [{ agentId: "a", enabled: true }] },
  { id: "q", name: "Support", enabled: true, members: [] },
  { id: "archived", name: "Archived", enabled: true, archivedAt: "today", members: [] },
] as unknown as ProjectRecord[];

function Form({ initial = { ...emptyBacklogForm(user), title: "Ship" }, save, createProject, choices = projects, projectChoice }: {
  initial?: TaskBoardFormState; save: (form: TaskBoardFormState) => void; createProject?: () => void; choices?: ProjectRecord[]; projectChoice?: "required" | "optional" | "locked";
}) {
  const [client] = useState(() => new QueryClient());
  const [form, setForm] = useState(initial);
  return <QueryClientProvider client={client}>
    <TaskDrawer open form={form} projectChoice={projectChoice} onChange={setForm} onSubmit={() => save(form)} onClose={vi.fn()}
      saving={false} title="New" subtitle="Task" projects={choices} onCreateProject={createProject}
      logicalAgents={[{ id: "a", displayName: "Member", supervisorUserId: "u" }, { id: "b", displayName: "Outside", supervisorUserId: "u" }] as any}
      teams={[{ id: "team", name: "Outside team", ownerUserId: "u" }] as any} />
  </QueryClientProvider>;
}

it("requires a project even when the task has a title", () => {
  const save = vi.fn(); render(<Form save={save} />);
  fireEvent.click(screen.getByRole("button", { name: "backlog.create_task" }));
  expect(save).not.toHaveBeenCalled();
  expect(screen.getByText("project.required")).toBeTruthy();
});

it("saves the selected project and limits executor choices to its roster", () => {
  const save = vi.fn(); render(<Form save={save} initial={{ ...emptyBacklogForm(user), title: "Ship", projectId: "p" }} />);
  expect(screen.getByTestId("assignment-options").textContent).toBe("Member");
  expect(screen.queryByRole("radio", { name: "backlog.statuses.assigned" })).toBeNull();
  expect(screen.queryByRole("radio", { name: "backlog.statuses.backlog" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "backlog.create_task" }));
  expect(save).toHaveBeenCalledWith(expect.objectContaining({ projectId: "p", title: "Ship", status: "backlog" }));
});

it("keeps the due date available under More options", () => {
  const save = vi.fn();
  render(<Form save={save} initial={{ ...emptyBacklogForm(user), title: "Ship", projectId: "p" }} />);
  const details = screen.getByText("backlog.more_options").closest("details")!;
  expect(details.open).toBe(false);
  details.open = true;
  expect(details.contains(screen.getByRole("button", { name: /backlog\.due/ }))).toBe(true);
  expect(screen.queryByRole("radio", { name: "backlog.statuses.assigned" })).toBeNull();
});

it("rejects an archived selected project at submit time", () => {
  const save = vi.fn(); render(<Form save={save} initial={{ ...emptyBacklogForm(user), title: "Ship", projectId: "archived" }} />);
  fireEvent.click(screen.getByRole("button", { name: "backlog.create_task" }));
  expect(save).not.toHaveBeenCalled();
  expect(screen.getByText("project.required")).toBeTruthy();
});

it("offers project creation without discarding the task draft", () => {
  const save = vi.fn(); const create = vi.fn(); render(<Form save={save} choices={[]} createProject={create} />);
  fireEvent.click(screen.getByRole("button", { name: "project.create_action" }));
  expect(create).toHaveBeenCalled();
  expect((screen.getByRole("textbox", { name: "backlog.title_field" }) as HTMLInputElement).value).toBe("Ship");
  expect(save).not.toHaveBeenCalled();
});

it("lets a routine be created without a project", () => {
  const save = vi.fn(); render(<Form save={save} initial={{ ...emptyRoutineForm(user), title: "Weekly review" }} />);
  fireEvent.click(screen.getByRole("button", { name: "routine.create" }));
  expect(save).toHaveBeenCalled();
  expect(screen.queryByText("project.required")).toBeNull();
});

it.each([false, true])("offers Project roster Agents without Teams (automation: %s)", (automation) => {
  const on = (computerId: string) => [{ computerId, desiredState: "active" }];
  const onComputer = [{ id: "pc", name: "On computer", enabled: true, computerId: "pc-1", members: [{ agentId: "a", enabled: true }] }] as unknown as ProjectRecord[];
  function Placed() {
    const [form, setForm] = useState<TaskBoardFormState>({ ...(automation ? emptyRoutineForm(user) : emptyBacklogForm(user)), title: "Ship", projectId: "pc" });
    return <TaskDrawer open form={form} onChange={setForm} onSubmit={vi.fn()} onClose={vi.fn()}
      saving={false} title="New" subtitle="Task" projects={onComputer}
      logicalAgents={[
        { id: "a", displayName: "Member", supervisorUserId: "u", placements: on("pc-1") },
        { id: "b", displayName: "Neighbour", supervisorUserId: "u", placements: on("pc-1") },
        { id: "c", displayName: "Far", supervisorUserId: "u", placements: on("pc-2") },
      ] as any}
      teams={[
        { id: "member", name: "Project team", ownerUserId: "u", memberAgentIds: ["a"] },
        { id: "near", name: "Near team", ownerUserId: "u", memberAgentIds: ["a", "b"] },
        { id: "split", name: "Split team", ownerUserId: "u", memberAgentIds: ["a", "c"] },
      ] as any} />;
  }
  render(<QueryClientProvider client={new QueryClient()}><Placed /></QueryClientProvider>);
  expect(screen.getByTestId("assignment-options").textContent).toBe("Member");
});


it("offers all available agents and teams for a standalone task without a project", () => {
  const save = vi.fn();
  render(<Form save={save} projectChoice="optional" />);
  expect(screen.getByTestId("assignment-options").textContent).toBe("Member,Outside");
  fireEvent.click(screen.getByRole("button", { name: "backlog.create_task" }));
  expect(save).toHaveBeenCalledWith(expect.objectContaining({ title: "Ship" }));
});

it("keeps executor editing available on a projectless routine run", () => {
  render(<Form save={vi.fn()} projectChoice="locked" initial={{
    ...emptyBacklogForm(user), id: "run", sourceRoutineId: "routine", title: "Nightly run",
  }} />);
  expect(screen.getByTestId("assignment-options")).toBeTruthy();
  expect(screen.queryByText("issues.assignment_needs_project")).toBeNull();
});


it("allows editing a saved standalone task's assignment", () => {
  const save = vi.fn();
  render(<Form save={save} projectChoice="optional" initial={{
    ...emptyBacklogForm(user), id: "legacy", title: "Standalone task", status: "assigned",
    assignedAgent: "codex", assignedAgentId: "a",
  }} />);
  expect(screen.getByTestId("assignment-options").textContent).toBe("Member,Outside");
  fireEvent.click(screen.getByRole("button", { name: "backlog.save_task" }));
  expect(save).toHaveBeenCalledWith(expect.objectContaining({ assignedAgentId: "a" }));
});

it.each([false, true])("rejects legacy Project Team assignment before submission (automation: %s)", (automation) => {
  const save = vi.fn();
  const form = { ...(automation ? emptyRoutineForm(user) : emptyBacklogForm(user)), title: "Ship", projectId: "p", assignedTeamId: "delivery" };
  const team = { id: "delivery", name: "Delivery", ownerUserId: "u", enabled: true, computerId: "c", memberAgentIds: ["a"],
    defaultWorkflowId: "scoped", workflows: [{ id: "scoped", projectId: "q", enabled: true, name: "Ship" }] } as AgentTeam;
  const view = (explicit = "") => <QueryClientProvider client={new QueryClient()}>
    <TaskDrawer open form={{ ...form, assignedWorkflowId: explicit }} onChange={vi.fn()} onSubmit={save} onClose={vi.fn()}
      saving={false} title="New" subtitle="Task" projects={projects.map(item => ({ ...item, computerId: "c" }))}
      logicalAgents={[{ id: "a", displayName: "Ada", placements: [{ computerId: "c", desiredState: "active" }] }] as any} teams={[team]} />
  </QueryClientProvider>;
  const { rerender } = render(view());
  expect(screen.getByRole("alert").textContent).toContain("backlog.assignment_reselect");
  const submit = screen.getByRole("button", { name: automation ? "routine.create" : "backlog.create_task" }) as HTMLButtonElement;
  expect(submit.disabled).toBe(true);
  fireEvent.submit(submit.form!);
  expect(save).not.toHaveBeenCalled();
  rerender(view("preset:pipeline"));
  expect(screen.getByRole("alert").textContent).toContain("backlog.assignment_reselect");
  fireEvent.click(screen.getByRole("button", { name: automation ? "routine.create" : "backlog.create_task" }));
  expect(save).not.toHaveBeenCalled();
});
