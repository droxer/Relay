import { createContext, useContext } from "react";
import { useState } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import { TaskDrawer } from "../src/components/task-board/TaskDrawer";
import { emptyBacklogForm, emptyRoutineForm, type TaskBoardFormState } from "../src/lib/taskBoardForm";
import type { CurrentUser, ProjectRecord, ProjectWorkflowChoice, UserAgent } from "../src/types";

vi.mock("@/components/ui/Drawer", () => ({ Drawer: ({ children }: any) => <div>{children}</div> }));
vi.mock("../src/components/task-board/TaskTagsField", () => ({ TaskTagsField: () => null }));
vi.mock("../src/components/connections/ConnectionGrantField", () => ({ ConnectionGrantField: () => null }));
vi.mock("../src/hooks/useSessionCapabilities", () => ({ useSessionCapabilities: () => ({}) }));
vi.mock("../src/api", () => ({ listProjectWorkflowChoices: vi.fn(async () => ({ workflows: [] })) }));

const currentUser = { userId: "owner", username: "owner" } as CurrentUser;
const project = { id: "p", name: "Project P", enabled: true, ownerUserId: "owner", computerId: "c",
  members: [{ agentId: "a", enabled: true, role: "reviewer", roleLevel: "junior" }] } as ProjectRecord;
const agent = { id: "a", displayName: "Ada", executorKind: "codex", enabled: true, supervisorUserId: "owner",
  defaultRole: "implementer", roleLevel: "senior", placements: [{ computerId: "c", desiredState: "active" }] } as UserAgent;
const workflow: ProjectWorkflowChoice = { id: "w", name: "Ship workflow", projectId: "p", enabled: true, stepAgentIds: ["a"] };

function mount(initial: TaskBoardFormState, custom = [workflow, { ...workflow, id: "foreign", projectId: "q", name: "Foreign workflow" }]) {
  const submit = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(["workflows", "choices", "p"], { workflows: custom });
  function Editor() {
    const [form, setForm] = useState(initial);
    return <TaskDrawer open form={form} projects={[project]} logicalAgents={[agent]} teams={[]} saving={false}
      title="Edit" subtitle="" projectChoice="optional" onClose={vi.fn()} onChange={setForm} onSubmit={submit} />;
  }
  const view = render(<QueryClientProvider client={client}><Editor /></QueryClientProvider>);
  return { ...view, submit };
}

it.each(["backlog", "routine"] as const)("repairs a saved stale Workflow in the %s editor", async variant => {
  const form = variant === "backlog" ? emptyBacklogForm(currentUser) : { ...emptyRoutineForm(currentUser), routineTriggers: [] };
  const { container, submit } = mount({ ...form, id: "saved", title: "Work", projectId: "p", assignedWorkflowId: "removed" });
  expect((await screen.findByRole("alert")).textContent).toContain("workflow.unavailable_selection");
  fireEvent.submit(container.querySelector("form")!);
  expect(submit).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("combobox", { name: "workflow.select_workflow" }));
  expect(screen.queryByRole("option", { name: /Foreign workflow/ })).toBeNull();
  fireEvent.click(screen.getByRole("option", { name: /Ship workflow/ }));
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  expect(screen.queryByText("workflow.optional_team")).toBeNull();
  fireEvent.submit(container.querySelector("form")!);
  expect(submit).toHaveBeenCalledOnce();
});

it.each(["backlog", "routine"] as const)("shows the Project Role and Role Level when assigning a %s", variant => {
  const form = variant === "backlog" ? emptyBacklogForm(currentUser) : { ...emptyRoutineForm(currentUser), routineTriggers: [] };
  mount({ ...form, title: "Work", projectId: "p" });
  const choice = screen.getByRole("option", { name: /Ada/ });
  expect(choice.textContent).toContain("role_levels.junior · admin.v2.agent_role.reviewer");
  fireEvent.click(choice);
  expect(screen.getByLabelText("backlog.assignment_label").textContent)
    .toContain("role_levels.junior · admin.v2.agent_role.reviewer");
});

it.each(["backlog", "routine"] as const)("offers an Agent or a Workflow, never both, in a new %s", async variant => {
  const form = variant === "backlog" ? emptyBacklogForm(currentUser) : { ...emptyRoutineForm(currentUser), routineTriggers: [] };
  mount({ ...form, title: "Work", projectId: "p" });
  const agentKind = screen.getByRole("radio", { name: "backlog.assignment_kind_agent" });
  const workflowKind = screen.getByRole("radio", { name: "backlog.assignment_kind_workflow" });
  expect(agentKind.getAttribute("aria-checked")).toBe("true");
  expect(screen.queryByRole("combobox", { name: "workflow.select_workflow" })).toBeNull();

  fireEvent.click(workflowKind);
  await waitFor(() => expect(workflowKind.getAttribute("aria-checked")).toBe("true"));
  // The agent picker gives way; the workflow picker offers workflows only.
  expect(screen.queryByText("backlog.assign_later")).toBeNull();
  fireEvent.click(screen.getByRole("combobox", { name: "workflow.select_workflow" }));
  expect(screen.queryByRole("option", { name: "workflow.project_default_agents" })).toBeNull();
  fireEvent.click(screen.getByRole("option", { name: /Ship workflow/ }));
  expect(screen.getByRole("combobox", { name: "workflow.select_workflow" }).textContent).toContain("Ship workflow");

  // Back to Agent drops the workflow rather than keeping both.
  fireEvent.click(agentKind);
  await waitFor(() => expect(screen.queryByRole("combobox", { name: "workflow.select_workflow" })).toBeNull());
  fireEvent.click(workflowKind);
  await waitFor(() => expect(screen.getByRole("combobox", { name: "workflow.select_workflow" }).textContent).toContain("workflow.choose"));
});

it.each(["backlog", "routine"] as const)("saves a predefined Workflow in a Project with no custom definitions (%s)", async variant => {
  const form = variant === "backlog" ? emptyBacklogForm(currentUser) : { ...emptyRoutineForm(currentUser), routineTriggers: [] };
  const { container, submit } = mount({ ...form, title: "Work", projectId: "p" }, []);
  fireEvent.click(screen.getByRole("radio", { name: "backlog.assignment_kind_workflow" }));
  expect(screen.getByRole<HTMLButtonElement>("option", { name: /collab_style.lead_led/ }).disabled).toBe(true);
  fireEvent.click(screen.getByRole("option", { name: /collab_style.pipeline/ }));
  expect(screen.getByRole("combobox", { name: "workflow.select_workflow" }).textContent).toContain("collab_style.pipeline");
  fireEvent.submit(container.querySelector("form")!);
  expect(submit).toHaveBeenCalledOnce();
});

it("opens a saved Workflow assignment on the Workflow side", () => {
  mount({ ...emptyBacklogForm(currentUser), id: "saved", title: "Work", projectId: "p", assignedWorkflowId: "w" });
  expect(screen.getByRole("radio", { name: "backlog.assignment_kind_workflow" }).getAttribute("aria-checked")).toBe("true");
  expect(screen.getByRole("combobox", { name: "workflow.select_workflow" }).textContent).toContain("Ship workflow");
});

it("clears Workflow assignment when an Automation leaves its Project", async () => {
  const { submit } = mount({ ...emptyRoutineForm(currentUser), title: "Automation", routineTriggers: [], projectId: "p", assignedWorkflowId: "w" });
  fireEvent.click(screen.getByRole("combobox", { name: "project.project" }));
  fireEvent.click(screen.getByRole("option", { name: "issues.no_project" }));
  expect(screen.queryByRole("combobox", { name: "workflow.select_workflow" })).toBeNull();
  expect(screen.queryByText("workflow.unavailable_selection")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "routine.create" }));
  expect(submit).toHaveBeenCalledOnce();
});

// Keep selection semantics while leaving popup positioning to browser tests.
vi.mock("@/components/ui/select", () => {
  const Context = createContext<any>({});
  return {
    Select: ({ children, value, onValueChange, disabled }: any) => <Context.Provider value={{ value, onValueChange, disabled }}>{children}</Context.Provider>,
    SelectTrigger: ({ children, id, ...rest }: any) => <button type="button" role="combobox" id={id} aria-label={rest["aria-label"]} aria-labelledby={rest["aria-labelledby"]}>{children}</button>,
    SelectValue: ({ children }: any) => { const { value } = useContext(Context); return <span>{typeof children === "function" ? children(value) : children}</span>; },
    SelectContent: ({ children, header }: any) => <div>{header}{children}</div>,
    SelectGroup: ({ children }: any) => <div>{children}</div>,
    SelectItem: ({ children, value, disabled }: any) => { const choice = useContext(Context); return <button type="button" role="option" disabled={disabled || choice.disabled} onClick={() => { if (value !== choice.value) choice.onValueChange(value); }}>{children}</button>; },
  };
});
