import { expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WorkflowEditor } from "../src/components/workflow/WorkflowEditor";
import { saveWorkflow, deleteWorkflow } from "../src/api";

vi.mock("../src/api", () => ({ saveWorkflow: vi.fn(async () => ({})), deleteWorkflow: vi.fn(async () => ({})) }));
vi.mock("@/components/ui/Drawer", () => ({ Drawer: ({ open, children }: any) => open ? <div>{children}</div> : null }));
vi.mock("@/components/ui/DialogProvider", () => ({ useDialogs: () => ({ confirm: async () => true }) }));
vi.mock("../src/hooks/useUnsavedChangesGuard", () => ({ useUnsavedChangesGuard: () => async () => true }));
vi.mock("../src/components/workflow/WorkflowStepCard", () => ({ WorkflowStepCard: ({ agents }: any) => <li>{agents.map((agent: any) => agent.displayName).join(",")}</li> }));
import { projectWorkflows, workflowTeams } from "../src/lib/workflowTeamDraft";
import { taskAssignmentMutationFields, taskBoardFormsEqual, emptyBacklogForm, teamAssignmentPatch } from "../src/lib/taskBoardForm";
import type { AgentTeam, ProjectRecord, TeamWorkflow } from "../src/types";

const project = { id: "project", computerId: "computer", members: [{ agentId: "builder", enabled: true }] } as ProjectRecord;
const workflow = { id: "build", teamId: "team", projectId: "project", name: "Build", enabled: true, workflowSteps: [] } as unknown as TeamWorkflow;
const team = { id: "team", name: "Delivery", computerId: "computer", memberAgentIds: ["builder", "specialist"], enabled: true,
  workflows: [workflow, { ...workflow, id: "fix", name: "Fix" }] } as AgentTeam;

it("lists distinct workflows under their team and filters Project scope", () => {
  expect(projectWorkflows([team], "project").map(item => item.id)).toEqual(["build", "fix"]);
  expect(projectWorkflows([team], "other")).toEqual([]);
  expect(projectWorkflows([{ ...team, deletedAt: "now" }], "project")).toEqual([]);
});

it("lets workflows use Project members from a larger team on the same Computer", () => {
  expect(workflowTeams([team, { ...team, id: "away", computerId: "other" }], project)).toEqual([team]);
});

it("saves workflow selection and clears it when the team changes", () => {
  const form = { ...emptyBacklogForm({ userId: "owner" } as Parameters<typeof emptyBacklogForm>[0]), assignedTeamId: team.id, assignedWorkflowId: workflow.id };
  expect(taskAssignmentMutationFields(form)).toEqual({ assignedAgentId: null, assignedTeamId: "team", assignedWorkflowId: "build" });
  expect(taskBoardFormsEqual(form, { ...form, assignedWorkflowId: "fix" })).toBe(false);
  expect(teamAssignmentPatch("other").assignedWorkflowId).toBe("");
  expect(taskAssignmentMutationFields({ ...form, assignedWorkflowId: "" }).assignedWorkflowId).toBeNull();
});

// Exercise the editor's request boundary without portal placement in jsdom.

const saved = { ...workflow, workflowSteps: [{ id: "implement", name: "Implement", agentId: "builder", instructions: "Build feature", acceptanceCriteria: ["Verified"], requiresApproval: false }] } as TeamWorkflow;

function renderEditor() {
  const onClose = vi.fn();
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  render(<QueryClientProvider client={queryClient}><WorkflowEditor open project={project} workflow={saved} teams={[team]}
    agents={[{ id: "builder", displayName: "Builder", enabled: true }, { id: "outsider", displayName: "Outsider", enabled: true }] as any}
    onClose={onClose} /></QueryClientProvider>);
  return onClose;
}

it("saves an independent Project definition without sending roster fields", async () => {
  const onClose = renderEditor();
  fireEvent.change(screen.getByRole("textbox", { name: "workflow.team_name" }), { target: { value: "Delivery" } });
  expect(screen.queryByText("Outsider")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "workflow.save" }));
  await waitFor(() => expect(saveWorkflow).toHaveBeenCalledWith({
    name: "Delivery", projectId: "project", workflowSteps: saved.workflowSteps, enabled: true,
  }, "build"));
  await waitFor(() => expect(onClose).toHaveBeenCalled());
});

it("deletes only the selected Workflow", async () => {
  const onClose = renderEditor();
  fireEvent.click(screen.getByRole("button", { name: "workflow.delete" }));
  await waitFor(() => expect(deleteWorkflow).toHaveBeenCalledWith("build"));
  await waitFor(() => expect(onClose).toHaveBeenCalled());
});
