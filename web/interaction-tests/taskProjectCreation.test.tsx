import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { TaskDrawer } from "../src/components/task-board/TaskDrawer";
import { emptyBacklogForm, emptyRoutineForm, type TaskBoardFormState } from "../src/lib/taskBoardForm";
import type { CurrentUser, ProjectRecord } from "../src/types";

vi.mock("@/components/ui/Drawer", () => ({ Drawer: ({ children }: any) => children }));
vi.mock("../src/components/assignment/AssignmentField", () => ({ AssignmentField: ({ agents, teams }: any) => <div data-testid="assignment-options">{agents.map((a: any) => a.displayName).join(",")}{teams.map((a: any) => a.name).join(",")}</div> }));
const user = { employeeId: "u", username: "u" } as CurrentUser;
const projects = [
  { id: "p", name: "Launch", enabled: true, members: [{ agentId: "a", enabled: true }] },
  { id: "q", name: "Support", enabled: true, members: [] },
  { id: "archived", name: "Archived", enabled: true, archivedAt: "today", members: [] },
] as unknown as ProjectRecord[];

function Form({ initial = { ...emptyBacklogForm(user), title: "Ship" }, save, createProject, choices = projects }: {
  initial?: TaskBoardFormState; save: (form: TaskBoardFormState) => void; createProject?: () => void; choices?: ProjectRecord[];
}) {
  const [form, setForm] = useState(initial);
  return <TaskDrawer open form={form} onChange={setForm} onSubmit={() => save(form)} onClose={vi.fn()}
    saving={false} title="New" subtitle="Task" projects={choices} onCreateProject={createProject}
    logicalAgents={[{ id: "a", displayName: "Member", supervisorEmployeeId: "u" }, { id: "b", displayName: "Outside", supervisorEmployeeId: "u" }] as any}
    teams={[{ id: "team", name: "Outside team", ownerEmployeeId: "u" }] as any} />;
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
  fireEvent.click(screen.getByRole("button", { name: "backlog.create_task" }));
  expect(save).toHaveBeenCalledWith(expect.objectContaining({ projectId: "p", title: "Ship" }));
});

it("rejects an archived selected project at submit time", () => {
  const save = vi.fn(); render(<Form save={save} initial={{ ...emptyBacklogForm(user), title: "Ship", projectId: "archived" }} />);
  fireEvent.click(screen.getByRole("button", { name: "backlog.create_task" }));
  expect(save).not.toHaveBeenCalled();
  expect(screen.getByText("project.required")).toBeTruthy();
});

it("offers project creation without discarding the task draft", () => {
  const save = vi.fn(); const create = vi.fn(); render(<Form save={save} choices={[]} createProject={create} />);
  fireEvent.click(screen.getByRole("button", { name: "project.create" }));
  expect(create).toHaveBeenCalled();
  expect((screen.getByRole("textbox", { name: "backlog.title_field" }) as HTMLInputElement).value).toBe("Ship");
  expect(save).not.toHaveBeenCalled();
});

it("requires a project for routines as well", () => {
  const save = vi.fn(); render(<Form save={save} initial={{ ...emptyRoutineForm(user), title: "Weekly review" }} />);
  fireEvent.click(screen.getByRole("button", { name: "routine.create" }));
  expect(save).not.toHaveBeenCalled();
  expect(screen.getByText("project.required")).toBeTruthy();
});

it("offers every agent and team on the project's computer, not just its roster", () => {
  const on = (computerId: string) => [{ computerId, desiredState: "active" }];
  const onComputer = [{ id: "pc", name: "On computer", enabled: true, computerId: "pc-1", members: [{ agentId: "a", enabled: true }] }] as unknown as ProjectRecord[];
  function Placed() {
    const [form, setForm] = useState<TaskBoardFormState>({ ...emptyBacklogForm(user), title: "Ship", projectId: "pc" });
    return <TaskDrawer open form={form} onChange={setForm} onSubmit={vi.fn()} onClose={vi.fn()}
      saving={false} title="New" subtitle="Task" projects={onComputer}
      logicalAgents={[
        { id: "a", displayName: "Member", supervisorEmployeeId: "u", placements: on("pc-1") },
        { id: "b", displayName: "Neighbour", supervisorEmployeeId: "u", placements: on("pc-1") },
        { id: "c", displayName: "Far", supervisorEmployeeId: "u", placements: on("pc-2") },
      ] as any}
      teams={[
        { id: "near", name: "Near team", ownerEmployeeId: "u", memberAgentIds: ["a", "b"] },
        { id: "split", name: "Split team", ownerEmployeeId: "u", memberAgentIds: ["a", "c"] },
      ] as any} />;
  }
  render(<Placed />);
  expect(screen.getByTestId("assignment-options").textContent).toBe("Member,NeighbourNear team");
});
