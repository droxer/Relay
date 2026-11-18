import { createContext, useContext } from "react";
import { useState } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import { TaskDrawer } from "../src/components/task-board/TaskDrawer";
import { emptyBacklogForm, emptyRoutineForm, type TaskBoardFormState } from "../src/lib/taskBoardForm";
import type { CurrentUser, ProjectRecord, UserAgent, Workflow } from "../src/types";

vi.mock("@/components/ui/Drawer", () => ({ Drawer: ({ children }: any) => <div>{children}</div> }));
vi.mock("../src/components/task-board/TaskTagsField", () => ({ TaskTagsField: () => null }));
vi.mock("../src/components/connections/ConnectionGrantField", () => ({ ConnectionGrantField: () => null }));
vi.mock("../src/hooks/useSessionCapabilities", () => ({ useSessionCapabilities: () => ({}) }));
vi.mock("../src/api", () => ({ listWorkflows: vi.fn(async () => ({ workflows: [] })) }));

const currentUser = { userId: "owner", username: "owner" } as CurrentUser;
const project = { id: "p", name: "Project P", enabled: true, ownerUserId: "owner", computerId: "c", members: [{ agentId: "a", enabled: true }] } as ProjectRecord;
const agent = { id: "a", displayName: "Ada", executorKind: "codex", enabled: true, supervisorUserId: "owner", placements: [{ computerId: "c", desiredState: "active" }] } as UserAgent;
const workflow = { id: "w", name: "Ship workflow", projectId: "p", enabled: true, workflowSteps: [{ agentId: "a" }] } as Workflow;

function mount(initial: TaskBoardFormState) {
  const submit = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(["workflows", "p"], { workflows: [workflow, { ...workflow, id: "foreign", projectId: "q", name: "Foreign workflow" }] });
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
  expect(screen.queryByRole("option", { name: "Foreign workflow" })).toBeNull();
  fireEvent.click(screen.getByRole("option", { name: "Ship workflow" }));
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  expect(screen.queryByText("workflow.optional_team")).toBeNull();
  fireEvent.submit(container.querySelector("form")!);
  expect(submit).toHaveBeenCalledOnce();
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
    SelectTrigger: ({ children, ...rest }: any) => <button type="button" role="combobox" aria-label={rest["aria-label"]} aria-labelledby={rest["aria-labelledby"]}>{children}</button>,
    SelectValue: ({ children }: any) => { const { value } = useContext(Context); return <span>{typeof children === "function" ? children(value) : children}</span>; },
    SelectContent: ({ children, header }: any) => <div>{header}{children}</div>,
    SelectGroup: ({ children }: any) => <div>{children}</div>,
    SelectItem: ({ children, value, disabled }: any) => { const choice = useContext(Context); return <button type="button" role="option" disabled={disabled || choice.disabled} onClick={() => { if (value !== choice.value) choice.onValueChange(value); }}>{children}</button>; },
  };
});
